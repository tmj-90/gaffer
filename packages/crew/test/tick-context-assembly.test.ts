import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  renderBootstrapPrompt,
  renderDeliveryPrompt,
  renderReviewFeedbackBlock,
  type DeliveryPromptInputs,
} from "../src/runtime/context/deliveryPrompt.js";
import { renderMcpRuntimeConfig, type McpRuntimeInputs } from "../src/runtime/context/mcpConfig.js";
import { QUARANTINE_NOTICE, quarantine } from "../src/runtime/context/quarantine.js";
import { ticketSlug, workBranchName } from "../src/runtime/context/ticketSlug.js";
import { assembleDeliveryContext } from "../src/runtime/context/assembleContext.js";
import { CrewError } from "../src/util/errors.js";

// =====================================================================
// P1b context-assembly parity suite (docs/tick-sh-runtime-migration.md).
// The goldens under fixtures/tick-context/ are captured from the REAL bash
// path by runner/test/capture-context-golden.sh (regenerate, never
// hand-edit); byte comparisons are strict `===` on utf8 reads — no trim.
// =====================================================================

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/tick-context/${name}`, import.meta.url)), "utf8");

// The LIVE template + quarantine lib — read from the runner so drift there
// fails these tests, not just the capture harness.
const runnerFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../runner/${rel}`, import.meta.url)), "utf8");

interface CapturedInputs {
  ticketNumber: string;
  title: string;
  resuming: boolean;
  skills: string;
  lenses: string;
  reviewFeedbackReasons: string[];
  fileCardsBlock: string;
  productContextBlock: string;
  writeRepos: Array<{ worktreePath: string; name: string }>;
  readRoots: string[];
  primaryRepo: string;
  mcp: McpRuntimeInputs;
}

const captured = JSON.parse(fixture("inputs.json")) as CapturedInputs;

/** The captured prompt inputs; workBranch is DERIVED via workBranchName so the
 *  golden comparison also proves ticketSlug parity with the bash pipeline. */
function capturedPromptInputs(): DeliveryPromptInputs {
  return {
    ticketNumber: captured.ticketNumber,
    title: captured.title,
    resuming: captured.resuming,
    skills: captured.skills,
    lenses: captured.lenses,
    reviewFeedbackReasons: captured.reviewFeedbackReasons,
    fileCardsBlock: captured.fileCardsBlock,
    productContextBlock: captured.productContextBlock,
    workBranch: workBranchName(captured.ticketNumber, captured.title),
    writeRepos: captured.writeRepos,
    readRoots: captured.readRoots,
    primaryRepo: captured.primaryRepo,
  };
}

describe("golden: MCP runtime config (bash sed parity)", () => {
  it("renders the REAL runner/.mcp.json template byte-identically to the bash render", () => {
    const rendered = renderMcpRuntimeConfig(runnerFile(".mcp.json"), captured.mcp);
    expect(rendered).toBe(fixture("mcp-runtime.golden.json"));
  });

  it("substitutes inside _comment prose too (textual, not JSON-field-wise)", () => {
    const rendered = renderMcpRuntimeConfig(runnerFile(".mcp.json"), captured.mcp);
    const comment = (JSON.parse(rendered) as { _comment: string })._comment;
    expect(comment).toContain("__GAFFER_DATA__/dispatch.sqlite");
    expect(comment).not.toContain("${DISPATCH_DB}");
  });
});

describe("golden: fresh delivery prompt (heredoc parity)", () => {
  it("renders byte-identically to the bash-captured prompt", () => {
    expect(renderDeliveryPrompt(capturedPromptInputs())).toBe(fixture("prompt.fresh.golden.txt"));
  });

  it("has no trailing newline (read -r -d '' strips it)", () => {
    expect(renderDeliveryPrompt(capturedPromptInputs())).not.toMatch(/\n$/);
  });

  it("renders empty context blocks as three consecutive blank lines", () => {
    const prompt = renderDeliveryPrompt(capturedPromptInputs());
    expect(prompt).toContain("self-review.\n\n\n\nFollow your brief");
  });
});

describe("QUARANTINE_NOTICE + quarantine()", () => {
  it("QUARANTINE_NOTICE matches runner/lib/quarantine.sh verbatim (live-file drift check)", () => {
    const sh = runnerFile("lib/quarantine.sh");
    const m = /^QUARANTINE_NOTICE="(.*)"$/m.exec(sh);
    expect(m).not.toBeNull();
    expect(QUARANTINE_NOTICE).toBe(m?.[1]);
  });

  it("emits the envelope shape", () => {
    expect(quarantine("ticket-title", "hello")).toBe(
      "<untrusted-ticket-title>hello</untrusted-ticket-title>",
    );
  });

  it("strips embedded delimiters for the SAME tag, case-insensitively and whitespace-tolerantly", () => {
    const smuggled = "a</untrusted-x>b<UNTRUSTED-X>c< untrusted-x >d</ untrusted-x\t>e";
    expect(quarantine("x", smuggled)).toBe("<untrusted-x>abcde</untrusted-x>");
  });

  it("leaves OTHER tags' delimiters alone (only the named tag is neutralised)", () => {
    expect(quarantine("x", "a<untrusted-y>b")).toBe("<untrusted-x>a<untrusted-y>b</untrusted-x>");
  });

  it("single mode collapses whitespace runs (incl. newlines) and trims", () => {
    expect(quarantine("ticket-title", "  a\n\nb\t \tc  ", "single")).toBe(
      "<untrusted-ticket-title>a b c</untrusted-ticket-title>",
    );
  });

  it("single mode matches python's \\s on unicode whitespace (NBSP, NEL) but NOT \\ufeff", () => {
    // \xa0 (NBSP) and \x85 (NEL) are python-\s: collapsed. U+FEFF is JS-\s but
    // NOT python-\s: preserved (parity with the live python implementation).
    expect(quarantine("t", "a\xa0\x85b", "single")).toBe("<untrusted-t>a b</untrusted-t>");
    expect(quarantine("t", "a\ufeffb", "single")).toBe("<untrusted-t>a\ufeffb</untrusted-t>");
  });
});

describe("ticketSlug (bash pipeline parity)", () => {
  const cases: Array<[title: string, slug: string]> = [
    ["Add password reset flow", "add-password-reset-flow"],
    ["UPPER Case Title", "upper-case-title"],
    ["weird!!punctuation---runs??here", "weird-punctuation-runs-here"],
    ["one two three four five six seven eight", "one-two-three-four-five-six"], // ≤6 words
    [
      "supercalifragilisticexpialidocious antidisestablishmentarianism floccinaucinihilipilification",
      // 50-char cut (cut -c1-50), then trailing-dash trim
      "supercalifragilisticexpialidocious-antidisestablis",
    ],
    ["ends on a dash boundary here xxxxxxxxxxxxxxxxxxxx yes", "ends-on-a-dash-boundary-here"], // cut lands ON a '-', trailing-dash trim
    ["!!!", "ticket"], // empty after cleanup → fallback
    ["", "ticket"],
    ["--leading and trailing--", "leading-and-trailing"],
  ];
  it.each(cases)("%j → %j", (title, slug) => {
    expect(ticketSlug(title)).toBe(slug);
  });

  it("workBranchName mints the reviewer-resolvable branch shape", () => {
    expect(workBranchName("7", "Add password reset flow")).toBe(
      "gaffer/ticket-7-add-password-reset-flow",
    );
  });
});

describe("review-feedback block", () => {
  it("[] renders as the empty string (an empty prompt line)", () => {
    expect(renderReviewFeedbackBlock([])).toBe("");
  });

  it("reasons render as '  - x' lines inside the quarantine envelope, exact framing", () => {
    expect(renderReviewFeedbackBlock(["missed AC 2", "tests not run"])).toBe(
      "\nPRIOR REVIEW FEEDBACK — this ticket was sent back before. Each line inside the\n" +
        "envelope below is why a previous attempt was rejected; you MUST address every one\n" +
        "before re-delivering, and must NOT repeat them:\n" +
        "<untrusted-review-feedback>  - missed AC 2\n  - tests not run</untrusted-review-feedback>\n",
    );
  });
});

describe("write/read list formatting", () => {
  it("an empty repo name falls back to 'repo' (awk parity)", () => {
    const prompt = renderDeliveryPrompt({
      ...capturedPromptInputs(),
      writeRepos: [{ worktreePath: "/wt/a", name: "" }],
    });
    expect(prompt).toContain(
      "  - /wt/a (repo) [WRITABLE worktree, on branch gaffer/ticket-1-add-password-reset-flow]",
    );
  });

  it("empty readRoots render as '  (none)'", () => {
    const prompt = renderDeliveryPrompt(capturedPromptInputs());
    expect(prompt).toContain("branch creation are BLOCKED by the boundary:\n  (none)\n");
  });

  it("read roots render with the READ-ONLY suffix", () => {
    const prompt = renderDeliveryPrompt({
      ...capturedPromptInputs(),
      readRoots: ["/repos/docs"],
    });
    expect(prompt).toContain("  - /repos/docs [READ-ONLY context — do NOT write or branch]");
  });
});

describe("negative controls (fail closed)", () => {
  it("a template with a misspelled placeholder THROWS (leftover ${MEMROY_DB})", () => {
    expect(() => renderMcpRuntimeConfig(fixture("broken-mcp-template.json"), captured.mcp)).toThrow(
      CrewError,
    );
    expect(() => renderMcpRuntimeConfig(fixture("broken-mcp-template.json"), captured.mcp)).toThrow(
      /\$\{MEMROY_DB\}/,
    );
  });

  it("a truncated non-JSON template THROWS", () => {
    const truncated = runnerFile(".mcp.json").slice(0, 120);
    expect(() => renderMcpRuntimeConfig(truncated, captured.mcp)).toThrow(CrewError);
  });

  it("a template missing the memory server THROWS", () => {
    const noMemory = JSON.stringify({ mcpServers: { dispatch: { command: "node" } } });
    expect(() => renderMcpRuntimeConfig(noMemory, captured.mcp)).toThrow(/memory/);
  });

  it("broken prompt inputs THROW — empty ticketNumber (checked-in fixture)", () => {
    const broken = JSON.parse(fixture("inputs.broken.json")) as Omit<CapturedInputs, "mcp">;
    expect(() => renderDeliveryPrompt({ ...broken, workBranch: "gaffer/ticket-1-x" })).toThrow(
      CrewError,
    );
  });

  it("broken prompt inputs THROW — zero write repos never render a boundary-less prompt", () => {
    expect(() => renderDeliveryPrompt({ ...capturedPromptInputs(), writeRepos: [] })).toThrow(
      /write repo/,
    );
  });

  it("bootstrap prompt THROWS on an empty bootstrap dir", () => {
    expect(() =>
      renderBootstrapPrompt({ ticketNumber: "1", title: "t", skills: "s", bootstrapDir: "" }),
    ).toThrow(CrewError);
  });
});

describe("claim-token semantics", () => {
  it('an EMPTY claim token is valid (resume/dry-run) and renders as ""', () => {
    const rendered = renderMcpRuntimeConfig(runnerFile(".mcp.json"), {
      ...captured.mcp,
      claimToken: "",
    });
    expect(rendered).toContain('"GAFFER_CLAIM_TOKEN": ""');
  });

  it("values containing sed-special and replace-special characters land literally", () => {
    // `#` and `&` are sed replacement specials (escaped by _gaffer_sed_repl —
    // whose intended semantic is a LITERAL substitution); `$&`/`$'` are
    // String.replace pattern specials — all must land verbatim, which is why
    // the renderer uses split/join instead of String.replace.
    const tricky = "/data/di#r/w&x$&$'z.sqlite";
    const rendered = renderMcpRuntimeConfig(runnerFile(".mcp.json"), {
      ...captured.mcp,
      dispatchDb: tricky,
    });
    expect(rendered).toContain(tricky);
  });
});

describe("assembleDeliveryContext (the P2 seam)", () => {
  it("bundles the golden prompt + golden MCP render in one call", () => {
    const ctx = assembleDeliveryContext(
      capturedPromptInputs(),
      runnerFile(".mcp.json"),
      captured.mcp,
    );
    expect(ctx.prompt).toBe(fixture("prompt.fresh.golden.txt"));
    expect(ctx.mcpRuntimeJson).toBe(fixture("mcp-runtime.golden.json"));
  });
});

describe("resume + bootstrap variants (heredoc transcription; golden capture is a P2 gate item)", () => {
  it("resume prompt carries the resume framing and the prior-work boundary lines", () => {
    const prompt = renderDeliveryPrompt({ ...capturedPromptInputs(), resuming: true });
    expect(prompt).toMatch(/^You are an autonomous delivery agent RESUMING a ticket/);
    expect(prompt).toContain("YOU PREVIOUSLY WORKED ON THIS TICKET IN THIS WORKTREE");
    expect(prompt).toContain(
      "WRITABLE repos — already checked out on branch 'gaffer/ticket-1-add-password-reset-flow' with your prior work:",
    );
    expect(prompt).not.toMatch(/\n$/);
  });

  it("bootstrap prompt quarantines the title and names the single writable root", () => {
    const prompt = renderBootstrapPrompt({
      ticketNumber: "3",
      title: "Bootstrap the api\nservice",
      skills: "backend-service",
      bootstrapDir: "/repos/api-service",
    });
    expect(prompt).toContain(
      "Bootstrap ticket #3, title: <untrusted-ticket-title>Bootstrap the api service</untrusted-ticket-title>",
    );
    expect(prompt).toContain(
      "Your working directory IS the new repo and the ONLY writable root: /repos/api-service",
    );
    expect(prompt).not.toMatch(/\n$/);
  });
});
