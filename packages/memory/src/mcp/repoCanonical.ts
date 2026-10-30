/**
 * Runner-bound repo canonicals for the file-card MCP tools (factory only).
 *
 * File cards are keyed by `repoKey(canonical)`, where the canonical is the
 * repo's normalised remote.origin.url, else its realpath (repoIdentity.ts). A
 * delivery agent works in a git WORKTREE: for a repo with a remote the worktree
 * shares origin and its guess is right, but for a local repo with no remote
 * (`gaffer onboard /local/path`) the obvious guess — its cwd — is the worktree
 * path, not the real repo's realpath the cards were written under, so every
 * card pull came back empty.
 *
 * The runner knows the right answer: it renders the ticket's repo NAME →
 * canonical map into the memory server env as `GAFFER_REPO_CANONICALS` (a JSON
 * object, see runner/.mcp.json). In factory context (`GAFFER_FACTORY=1`) the
 * card tools use that binding for a named repo, so `repoCanonical` is optional
 * there and an agent's wrong guess cannot hide the cards. Outside the factory,
 * or for a repo the map does not name, the caller's `repoCanonical` is used
 * unchanged — standalone memory-mcp behaviour is identical to before.
 *
 * FAIL-SAFE: an absent, empty, unsubstituted (`${...}`, from a partially
 * rendered config) or malformed value is treated as "no binding".
 */
import { scopeEnforcementActive } from "./scopeGuard.js";

const UNSUBSTITUTED_PLACEHOLDER = /\$\{[^}]*\}/;

/** Parse the `GAFFER_REPO_CANONICALS` JSON object into a name → canonical map. */
export function parseRepoCanonicals(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const raw = (value ?? "").trim();
  if (!raw || UNSUBSTITUTED_PLACEHOLDER.test(raw)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [name, canonical] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof canonical === "string" && name.trim() && canonical.trim()) {
      out.set(name.trim(), canonical.trim());
    }
  }
  return out;
}

/** The runner-bound canonical for `repo`, or undefined (standalone / not named). */
export function boundRepoCanonical(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!scopeEnforcementActive(env)) return undefined;
  return parseRepoCanonicals(env["GAFFER_REPO_CANONICALS"]).get(repo.trim());
}

/**
 * Resolve the canonical a card tool should key on: the runner binding for the
 * named repo (factory), else the caller's `repoCanonical`. Throws when neither
 * is available so the tool returns a clear error instead of an empty result.
 */
export function resolveCardCanonical(
  repo: string,
  supplied: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bound = boundRepoCanonical(repo, env);
  if (bound) return bound;
  const s = (supplied ?? "").trim();
  if (s) return s;
  throw new Error(
    `repoCanonical is required for repo '${repo}' — pass the repo's remote origin URL ` +
      "or its absolute realpath (the runner binds it only for the ticket's own repos)",
  );
}
