import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../../core/audit.js";
import {
  diagnoseRepoKeyMismatch,
  getFileCard,
  repoKey,
  searchFileCards,
} from "../../core/fileCards.js";
import { cardsForScope } from "../../core/scopePacket.js";
import {
  quarantineCard,
  quarantineDigest,
  quarantineLore,
  QUARANTINE_NOTICE,
} from "../quarantine.js";

/**
 * Register the file-card retrieval MCP tools onto `server`:
 *
 *   - get_file_card     — fetch one file's card (retrieval aid, not source).
 *   - search_file_cards — FTS5 search over a repo's cards.
 *   - cards_for_scope   — budgeted, prioritised start-of-task packet: cards +
 *                         repo digest + top lore, all quarantine-wrapped.
 */
export function registerCardTools(server: McpServer, db: Database): void {
  // ---- get_file_card ---------------------------------------------------
  server.registerTool(
    "get_file_card",
    {
      title: "Get a file card (retrieval aid — not authoritative source)",
      description:
        "Fetch the card for a single file in a repo. A card is a RETRIEVAL " +
        "AID that helps you choose what to read — it does NOT replace reading " +
        "the actual file before editing. Mechanical fields (path, symbols, loc) " +
        "are always present when a card exists. Model fields (tldr, role) are " +
        "only present when the summary passed validation (model_status=active).\n\n" +
        "Returns null when no active card exists for the path. Absence of a " +
        "card does NOT mean the file is unimportant — it means no card has been " +
        "written for it yet. Read the file directly in that case.\n\n" +
        "Pass `repoCanonical` = the repo's remote origin URL (preferred) or its " +
        "absolute realpath on disk. The display `repo` name is used for digest " +
        "and lore queries only.",
      inputSchema: {
        repoCanonical: z
          .string()
          .min(1)
          .describe(
            "Canonical repo identifier: remote origin URL (e.g. " +
              "'https://github.com/org/repo') or absolute local realpath. " +
              "Used as the stable repo identity key — do NOT use the display name.",
          ),
        repo: z.string().min(1).describe("Human-readable repo name (e.g. 'payments-svc')."),
        path: z
          .string()
          .min(1)
          .describe("Relative file path within the repo (e.g. 'src/api/payments.ts')."),
      },
    },
    async (args) => {
      try {
        const rk = repoKey(args.repoCanonical);
        const card = getFileCard(db, rk, args.path);
        audit({
          tool: "get_file_card",
          request: { repoCanonical: args.repoCanonical, repo: args.repo, path: args.path },
          resultCount: card ? 1 : 0,
          resultIds: card ? [card.id] : [],
        });
        const out = card
          ? {
              found: true,
              // Model-derived text (tldr / role_primary) is wrapped in the
              // quarantine envelope so it arrives as DATA, not instructions.
              // Mechanical fields (path, symbols, loc) stay raw.
              card: quarantineCard(card),
              security: QUARANTINE_NOTICE,
              caveat:
                "This card is a retrieval aid — verify against the actual file " +
                "before making changes. Model fields (tldr, role) are only present " +
                "when model_status='active'.",
            }
          : {
              found: false,
              path: args.path,
              message:
                "No active card for this path. The file may exist but have no " +
                "card yet, or the card may be stale/shadow. Read the file directly.",
            };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "get_file_card",
          request: { repoCanonical: args.repoCanonical, repo: args.repo, path: args.path },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `get_file_card failed: ${msg}` }],
        };
      }
    },
  );

  // ---- search_file_cards -----------------------------------------------
  server.registerTool(
    "search_file_cards",
    {
      title: "Search file cards (retrieval aid — not authoritative source)",
      description:
        "FTS5 search over file cards in a repo — searches path, tldr, and " +
        "symbol names. Returns cards ordered by bm25 relevance.\n\n" +
        "Cards are RETRIEVAL AIDS — they help you choose which files to inspect. " +
        "They do NOT replace reading the actual code before editing. Model fields " +
        "(tldr, role) are only present when model_status='active'; a card with " +
        "model_status='absent' still has useful mechanical fields (path, symbols).\n\n" +
        "For a budgeted, prioritised multi-tier assembly (path-first, then FTS, " +
        "then lore) use `cards_for_scope` instead — it is the preferred call " +
        "for starting a task.",
      inputSchema: {
        repoCanonical: z
          .string()
          .min(1)
          .describe("Canonical repo identifier: remote origin URL or absolute local realpath."),
        repo: z.string().min(1).describe("Human-readable repo name."),
        query: z.string().min(1).describe("Free-text query (FTS5 over path, tldr, symbols)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results. Default 20, hard cap 50."),
      },
    },
    async (args) => {
      try {
        const rk = repoKey(args.repoCanonical);
        const limit = Math.min(args.limit ?? 20, 50);
        const cards = searchFileCards(db, rk, args.query, limit);
        // FAIL LOUD but OUT-OF-BAND: an empty result while cards exist under a
        // different key is a canonical/key mismatch, not "no cards". Surface it
        // to stderr (operator log), NOT into the agent-facing result — the
        // diagnostic names other repos' keys and is untrusted context noise.
        // Consistent with every other diagnostic path (logs go to stderr).
        const diagnostic =
          cards.length === 0
            ? diagnoseRepoKeyMismatch(db, rk, args.repo, args.repoCanonical)
            : null;
        if (diagnostic) process.stderr.write(`memory-mcp: ${diagnostic}\n`);
        audit({
          tool: "search_file_cards",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
            limit,
          },
          resultCount: cards.length,
          resultIds: cards.map((c) => c.id),
        });
        const out = {
          query: args.query,
          repo: args.repo,
          count: cards.length,
          // Model-derived text on each card is wrapped in the quarantine
          // envelope so it arrives as DATA, not instructions.
          cards: cards.map((c) => quarantineCard(c)),
          security: QUARANTINE_NOTICE,
          caveat:
            "Cards are retrieval aids — use them to choose files to read, not " +
            "as a substitute for reading the code. Model fields (tldr, role) " +
            "are only present when model_status='active'.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "search_file_cards",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
          },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `search_file_cards failed: ${msg}` }],
        };
      }
    },
  );

  // ---- cards_for_scope ------------------------------------------------
  server.registerTool(
    "cards_for_scope",
    {
      title: "Get a budgeted scope packet of file cards (retrieval aids)",
      description:
        "**Call this at the START of a task** to orient yourself before reading " +
        "code. Returns a budgeted, prioritised packet of file cards relevant to " +
        "the given scope — plus the repo digest and top lore records.\n\n" +
        "RETRIEVAL AID FRAMING (non-negotiable):\n" +
        "  File cards help you CHOOSE WHAT TO READ. They are never authoritative\n" +
        "  source. Before editing any file, you MUST read the actual file or a\n" +
        "  real excerpt. Absence of a card does NOT mean the file is safe to\n" +
        "  ignore — it means no card exists yet.\n\n" +
        "SELECTION PRIORITY (deterministic signals always outrank fuzzy):\n" +
        "  1. Exact `paths` matches — highest confidence.\n" +
        "  2. Path-prefix matches of `paths` — files under those directories.\n" +
        "  3. `importantPaths` exact + prefix — caller-flagged context.\n" +
        "  4. FTS over path / tldr / symbols — fuzzy, never outranks filename hits.\n" +
        "  5. Repo digest + top lore — always included.\n\n" +
        "RESULT TRANSPARENCY:\n" +
        "  `omitted` lists cards excluded by budget + why.\n" +
        "  `coverage.missing` lists requested paths with no card in the DB.\n" +
        "  `truncationReason` explains why the result was cut short.\n" +
        "  Absence of a card ≠ the file is unimportant.",
      inputSchema: {
        repoCanonical: z
          .string()
          .min(1)
          .describe(
            "Canonical repo identifier: remote origin URL (preferred) or " +
              "absolute local realpath. Used as the stable repo identity key.",
          ),
        repo: z
          .string()
          .min(1)
          .describe("Human-readable repo name. Used for digest + lore queries."),
        query: z
          .string()
          .min(1)
          .describe(
            "Free-text scope description — the task, feature, or area being " +
              "changed. Used for FTS (tier 4) and lore lookup (tier 5).",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit file paths known to be in scope. Tier-1 = exact matches; " +
              "tier-2 = directory-prefix expansion (all files under these dirs). " +
              "Path-based cards always outrank FTS results.",
          ),
        importantPaths: z
          .array(z.string())
          .optional()
          .describe(
            "Additional paths the caller considers important context (tier 3). " +
              "Lower priority than `paths` but higher than FTS.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max cards to return. Default 20, hard cap 100."),
        maxTokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Overall token budget (estimated as chars/4). Cards that would push " +
              "the total over this limit are moved to `omitted`.",
          ),
        perCardMaxTokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Per-card token cap. Cards exceeding this have their `tldr` " +
              "truncated to fit. The card is still returned — truncated content " +
              "is better than no content.",
          ),
      },
    },
    async (args) => {
      try {
        const maxCards = Math.min(args.limit ?? 20, 100);
        const packet = cardsForScope(db, {
          repoCanonical: args.repoCanonical,
          repo: args.repo,
          query: args.query,
          paths: args.paths,
          importantPaths: args.importantPaths,
          maxCards,
          maxTokens: args.maxTokens,
          perCardMaxTokens: args.perCardMaxTokens,
        });
        audit({
          tool: "cards_for_scope",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
            pathCount: args.paths?.length ?? 0,
            maxCards,
          },
          resultCount: packet.cards.length,
          resultIds: packet.cards.map((c) => c.id),
        });
        // A canonical/key mismatch diagnostic is an operator concern — log it
        // to stderr, never into the agent-facing packet (it names other repos'
        // keys and is untrusted noise). Consistent with search_file_cards.
        const { diagnostics, ...packetRest } = packet;
        if (diagnostics?.length) {
          for (const d of diagnostics) process.stderr.write(`memory-mcp: ${d}\n`);
        }
        // Wrap every agent-facing free-text span in the packet — cards, the
        // repo digest, and the lore hits — in the quarantine envelope. This
        // packet is the START-OF-TASK orientation context, the single biggest
        // poisoning surface, so all three record kinds arrive as DATA, never
        // instructions. Selection metadata / paths / coverage stay raw.
        const out = {
          ...packetRest,
          cards: packet.cards.map((c) => quarantineCard(c)),
          digest: packet.digest ? quarantineDigest(packet.digest) : packet.digest,
          lore: packet.lore.map((l) => quarantineLore(l)),
          security: QUARANTINE_NOTICE,
          caveat:
            "File cards are retrieval aids — use them to choose what to read, " +
            "not as a substitute for reading the actual code. Before editing any " +
            "file, read the real file or a real excerpt. Absence of a card ≠ the " +
            "file is unimportant.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "cards_for_scope",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
          },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `cards_for_scope failed: ${msg}` }],
        };
      }
    },
  );
}
