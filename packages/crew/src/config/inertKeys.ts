/**
 * crew.yaml keys the LIVE factory never reads.
 *
 * The schema accepts them (so existing configs stay valid), but nothing in the
 * runner (runner/tick.sh + runner/lib) consumes them: they either drive only
 * the MOCK `crew run` loop, or have no consumer at all. An operator who sets one
 * gets no effect and no error, and the security-sounding ones read as promises.
 * `crew doctor` reports them from the RAW YAML (so a key left at its default is
 * still named), and test/config-inert-keys.test.ts keeps this list honest: a
 * "no consumer" key that gains one, or a template line that loses its marker,
 * fails the test.
 */
export interface InertKey {
  /** Dotted path from the config root; `repos[].x` means "x on any repo". */
  readonly path: string;
  /** `mock-only`: read only by `crew run` (MockAgentRuntime). `unread`: no consumer. */
  readonly scope: "mock-only" | "unread";
  /** What the operator should use instead, or why it is safe to delete. */
  readonly note: string;
  /**
   * Values that mean "untouched" (the schema default and whatever `crew init`
   * scaffolded). Any other value is a deliberate setting with no effect → warn.
   */
  readonly untouched: readonly unknown[];
}

const DOD_DEFAULT = { enabled: true, tests: true, typecheck: true, lint: true };
const DOD_NOTE =
  "the live Definition-of-Done gates are toggled by GAFFER_DOD / GAFFER_DOD_TESTS / " +
  "GAFFER_DOD_TYPECHECK / GAFFER_DOD_LINT env vars (docs/CONFIG.md), not crew.yaml";

export const INERT_CONFIG_KEYS: readonly InertKey[] = [
  { path: "definition_of_done", scope: "unread", note: DOD_NOTE, untouched: [DOD_DEFAULT] },
  // Any per-repo override is a deliberate setting, so nothing counts as untouched.
  { path: "repos[].definition_of_done", scope: "unread", note: DOD_NOTE, untouched: [] },
  {
    path: "hooks.enabled",
    scope: "mock-only",
    note: "hooks run only inside the mock `crew run` loop",
    untouched: [false],
  },
  {
    path: "loops.implementation.post_conditions.enabled",
    scope: "mock-only",
    note: "post-conditions are checked only by the mock `crew run` loop; the live gates are the runner's DoD / hygiene / acceptance checks",
    untouched: [false],
  },
  {
    path: "context.token_budget",
    scope: "unread",
    note: "nothing flags packets against it; safe to delete",
    untouched: [null],
  },
  {
    path: "safety.require_clean_worktree_before_start",
    scope: "unread",
    note: "the runner always delivers in a fresh worktree; safe to delete",
    untouched: [true],
  },
  {
    path: "safety.redact_secrets_in_context",
    scope: "unread",
    note: "context-packet redaction always runs, so false changes nothing; safe to delete",
    untouched: [true],
  },
  {
    path: "safety.model_may_read_secret_files",
    scope: "unread",
    note: "secret reads are blocked by runner/safety-hook.mjs regardless of this key; safe to delete",
    untouched: [false],
  },
  {
    path: "memory.required_before",
    scope: "unread",
    note: "no step requires lore before these tags; safe to delete",
    untouched: [
      { tags: [] },
      { tags: ["auth", "payments", "migrations", "public_api", "security"] },
    ],
  },
  {
    path: "memory.suggestion_policy",
    scope: "unread",
    note: "memory promotion is the runner's policy (MEMORY_AUTO_APPROVE / GAFFER_MEMORY_AUTO_PROMOTE); safe to delete",
    untouched: [{ after_ticket_done: true, auto_approve: false }],
  },
];

export interface InertKeyHit {
  readonly key: InertKey;
  /** The concrete path that was found (a repo override names its repo). */
  readonly at: string;
  readonly value: unknown;
  /** True when the value differs from every untouched value (a deliberate setting). */
  readonly deliberate: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stable JSON (sorted keys) so `{a,b}` and `{b,a}` compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function lookup(raw: unknown, dotted: string): { found: boolean; value: unknown } {
  let cur: unknown = raw;
  for (const part of dotted.split(".")) {
    if (!isRecord(cur) || !(part in cur)) return { found: false, value: undefined };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

/** Every inert key present in a RAW (un-defaulted) parsed crew.yaml. */
export function findInertKeys(raw: unknown): InertKeyHit[] {
  const hits: InertKeyHit[] = [];
  const add = (key: InertKey, at: string, value: unknown): void => {
    const deliberate = !key.untouched.some((u) => stable(u) === stable(value));
    hits.push({ key, at, value, deliberate });
  };
  for (const key of INERT_CONFIG_KEYS) {
    if (key.path.startsWith("repos[].")) {
      const leaf = key.path.slice("repos[].".length);
      const repos = isRecord(raw) && Array.isArray(raw.repos) ? raw.repos : [];
      for (const repo of repos) {
        const { found, value } = lookup(repo, leaf);
        if (!found) continue;
        const name = isRecord(repo) ? String(repo.name ?? repo.id ?? "?") : "?";
        add(key, `repos[${name}].${leaf}`, value);
      }
      continue;
    }
    const { found, value } = lookup(raw, key.path);
    if (found) add(key, key.path, value);
  }
  return hits;
}
