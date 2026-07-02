/**
 * CLI dispatcher integration tests. The `core/*` layer is unit-tested
 * heavily elsewhere; this file pins the surface a user actually hits —
 * `main(argv)` end-to-end against a real (temp) SQLite DB: exit codes,
 * flag-conflict refusals, lifecycle commands, and stdout/stderr shape.
 *
 * We drive `main(["node", "memory", ...args])` (it skips argv[0..1])
 * and capture writes by patching process.stdout / process.stderr. Each
 * test gets its own DB via MEMORY_DB; audit + telemetry are silenced.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { VERSION } from "../src/version.js";

let dir: string;
let out: string;
let err: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const prevEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-cli-"));
  for (const k of ["MEMORY_DB", "MEMORY_AUDIT_OFF", "MEMORY_AUDIT_LOG", "MEMORY_NO_TELEMETRY"]) {
    prevEnv[k] = process.env[k];
  }
  process.env["MEMORY_DB"] = join(dir, "lore.db");
  process.env["MEMORY_AUDIT_OFF"] = "1";
  out = "";
  err = "";
  // process.stdout/stderr `write` is overloaded; capture writes for assertions.
  // The spy is widened to the generic MockInstance the suite stores.
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as unknown as typeof outSpy;
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += chunk.toString();
    return true;
  }) as unknown as typeof errSpy;
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Run a memory command; returns the exit code. stdout/stderr land in out/err. */
async function run(...args: string[]): Promise<number> {
  return main(["node", "memory", ...args]);
}

/** Pull the first 8-char id printed (from `add`/`suggest` output). */
function firstId(s: string): string {
  const m = /\b([a-z2-9]{8})\b/.exec(s);
  if (!m) throw new Error(`no id found in: ${s}`);
  return m[1]!;
}

/**
 * Pull a boundary id from `boundary add/suggest` output. The plain
 * firstId can't be used here: the role words "provides"/"consumes" and
 * the literal "boundary" are all 8 lowercase letters and collide with
 * the id alphabet, so we read the id from the parenthesised `(<id>)`
 * form that renderBoundary prints.
 */
function boundaryId(s: string): string {
  const m = /\(([a-z2-9]{8})\)/.exec(s);
  if (!m) throw new Error(`no boundary id found in: ${s}`);
  return m[1]!;
}

describe("CLI dispatch — basics", () => {
  it("--help and --version short-circuit with code 0", async () => {
    expect(await run("--help")).toBe(0);
    expect(out).toContain("memory <command>");
    out = "";
    expect(await run("--version")).toBe(0);
    expect(out.trim()).toBe(VERSION);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/); // and it's a real semver
  });

  it("unknown command exits 2 and prints help to stderr", async () => {
    expect(await run("frobnicate")).toBe(2);
    expect(err).toContain("unknown command 'frobnicate'");
  });

  it("init creates the DB and reports the path", async () => {
    expect(await run("init")).toBe(0);
    expect(out).toContain("initialised at");
  });
});

describe("CLI — add / search / show lifecycle", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
  });

  it("add creates an active record findable by search; show prints the body", async () => {
    expect(
      await run(
        "add",
        "--title",
        "Argon2id is the hash default",
        "--summary",
        "Platform ruling",
        "--body",
        "Use m=64MB t=3 p=4",
        "--source",
        "https://example.com/adr/1",
        "--confidence",
        "high",
      ),
    ).toBe(0);
    const id = firstId(out);
    out = "";

    expect(await run("search", "argon2id")).toBe(0);
    expect(out).toContain("Argon2id is the hash default");
    out = "";

    expect(await run("show", id)).toBe(0);
    expect(out).toContain("Use m=64MB t=3 p=4"); // body present in show
  });

  it("search with no matches prints a friendly message, code 0", async () => {
    expect(await run("search", "nonexistent-topic-xyz")).toBe(0);
    expect(out).toContain("no matches");
  });

  it("show with an unknown id exits 1", async () => {
    expect(await run("show", "zzzzzzzz")).toBe(1);
    expect(err).toContain("no record with id");
  });

  it("show with no id exits 2", async () => {
    expect(await run("show")).toBe(2);
  });
});

describe("CLI — draft review flow", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
  });

  it("suggest lands as a draft, hidden from default search until approved", async () => {
    await run("suggest", "--title", "Draft rule", "--summary", "s", "--body", "b");
    const id = firstId(out);
    out = "";
    // Draft excluded from default search.
    await run("search", "Draft rule");
    expect(out).not.toContain("Draft rule");
    out = "";
    // approve → now active and findable.
    expect(await run("approve", id)).toBe(0);
    out = "";
    await run("search", "Draft rule");
    expect(out).toContain("Draft rule");
  });

  it("reject refuses a non-draft (active) record, exits 1", async () => {
    await run("add", "--title", "Active rec", "--summary", "s", "--body", "b");
    const id = firstId(out);
    out = "";
    err = "";
    expect(await run("reject", id)).toBe(1);
    expect(err).toContain("not a draft");
  });

  it("review --list shows pending drafts", async () => {
    await run("suggest", "--title", "Pending one", "--summary", "s", "--body", "b");
    out = "";
    expect(await run("review", "--list")).toBe(0);
    expect(out).toContain("Pending one");
    expect(out).toContain("awaiting review");
  });
});

describe("CLI — update flag-conflict refusals", () => {
  let id: string;
  beforeEach(async () => {
    await run("init");
    out = "";
    await run("add", "--title", "Editable", "--summary", "s", "--body", "b");
    id = firstId(out);
    out = "";
    err = "";
  });

  it("--clear-source conflicts with --source, exits 2", async () => {
    expect(await run("update", id, "--clear-source", "--source", "https://x.example.com")).toBe(2);
    expect(err).toContain("--clear-source conflicts with --source");
  });

  it("--clear-tags conflicts with --tag, exits 2", async () => {
    expect(await run("update", id, "--clear-tags", "--tag", "foo")).toBe(2);
    expect(err).toContain("--clear-tags conflicts with --tag");
  });

  it("update with no field flags exits 2", async () => {
    expect(await run("update", id)).toBe(2);
    expect(err).toContain("at least one field flag");
  });

  it("a valid update succeeds and is reflected in show", async () => {
    expect(await run("update", id, "--summary", "new summary text")).toBe(0);
    out = "";
    await run("show", id);
    expect(out).toContain("new summary text");
  });
});

describe("CLI — prune", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
  });

  it("prune --dry-run reports counts and writes nothing", async () => {
    expect(await run("prune", "--dry-run")).toBe(0);
    expect(out).toContain("dry-run");
    expect(out).toMatch(/would delete \d+ read event/);
  });

  it("prune rejects a bad --read-events-older-than, exits 2", async () => {
    expect(await run("prune", "--read-events-older-than", "notanumber")).toBe(2);
    expect(err).toContain("non-negative integer");
  });

  it("prune runs and reports deletions, exits 0", async () => {
    expect(await run("prune")).toBe(0);
    expect(out).toContain("deleted");
  });
});

describe("CLI — boundary + impact", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
    err = "";
  });

  it("boundary add (active) then impact shows providers/consumers across spellings", async () => {
    expect(
      await run("boundary", "add", "orders-svc", "OrderSubmitted", "provides", "--kind", "event"),
    ).toBe(0);
    out = "";
    expect(await run("boundary", "add", "reporting-svc", "order-submitted", "consumes")).toBe(0);
    out = "";
    expect(await run("impact", "order_submitted")).toBe(0);
    expect(out).toContain("order-submitted");
    expect(out).toContain("orders-svc");
    expect(out).toContain("reporting-svc");
    expect(out).toMatch(/Providers.*1/s);
    expect(out).toMatch(/Consumers.*1/s);
  });

  it("boundary suggest lands a draft hidden from the default map until approved", async () => {
    await run("boundary", "suggest", "svc", "thing", "provides");
    const id = boundaryId(out);
    out = "";
    // Default list excludes drafts.
    await run("boundary", "list");
    expect(out).not.toContain(id);
    out = "";
    // approve → visible.
    expect(await run("boundary", "approve", id)).toBe(0);
    out = "";
    await run("boundary", "list");
    expect(out).toContain(id);
  });

  it("boundary add rejects a bad role, exits 2", async () => {
    expect(await run("boundary", "add", "svc", "c", "uses")).toBe(2);
    expect(err).toContain("provides");
  });

  it("impact with no contract exits 2", async () => {
    expect(await run("impact")).toBe(2);
  });

  it("boundary reject drops a draft; refuses an active edge", async () => {
    await run("boundary", "suggest", "svc", "c", "consumes");
    const id = boundaryId(out);
    out = "";
    expect(await run("boundary", "reject", id)).toBe(0);
    out = "";
    err = "";
    // Now add an active edge and confirm reject refuses it.
    await run("boundary", "add", "svc2", "c2", "provides");
    const activeId = boundaryId(out);
    err = "";
    expect(await run("boundary", "reject", activeId)).toBe(1);
    expect(err).toContain("not a draft");
  });
});

describe("CLI — absent record/list", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
  });

  it("records a marker and lists it; requires --reason", async () => {
    err = "";
    expect(await run("absent", "record", "retry policy")).toBe(2);
    expect(err).toContain("requires --reason");
    out = "";
    expect(await run("absent", "record", "retry policy", "--reason", "no team policy")).toBe(0);
    expect(out).toContain("recorded absence marker");
    out = "";
    expect(await run("absent", "list")).toBe(0);
    expect(out).toContain("no team policy");
  });
});

describe("CLI — search truncation + prune integrity", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
  });

  it("search prints 'showing N of M' when the result set is capped", async () => {
    for (let i = 0; i < 6; i++) {
      await run("add", "--title", `widget tracker ${i}`, "--summary", "s", "--body", "b");
    }
    out = "";
    expect(await run("search", "widget", "tracker", "--limit", "2")).toBe(0);
    expect(out).toMatch(/showing 2 of 6 matches/);
  });

  it("search does NOT print the truncation line when everything fits", async () => {
    await run("add", "--title", "solo widget", "--summary", "s", "--body", "b");
    out = "";
    await run("search", "solo widget");
    expect(out).not.toMatch(/showing \d+ of/);
  });

  it("prune --vacuum preserves all lore rows (GC doesn't lose data)", async () => {
    await run("add", "--title", "keep me one", "--summary", "s", "--body", "b");
    await run("add", "--title", "keep me two", "--summary", "s", "--body", "b");
    out = "";
    expect(await run("prune", "--read-events-older-than", "0", "--vacuum")).toBe(0);
    out = "";
    await run("search", "keep me");
    expect(out).toContain("keep me one");
    expect(out).toContain("keep me two");
  });
});

describe("CLI — boundary review (non-TTY list mode)", () => {
  beforeEach(async () => {
    await run("init");
    out = "";
  });

  it("boundary review falls back to a list under non-TTY stdin", async () => {
    await run("boundary", "suggest", "svc", "thing", "provides");
    out = "";
    // stdin is non-TTY under vitest, so review prints the list and returns 0
    // rather than blocking on a prompt.
    expect(await run("boundary", "review")).toBe(0);
    expect(out).toContain("awaiting review");
    expect(out).toContain("svc");
  });

  it("boundary review reports an empty queue cleanly", async () => {
    expect(await run("boundary", "review")).toBe(0);
    expect(out).toContain("no pending boundary drafts");
  });
});

describe("CLI — cross-repo sync pull aggregates the boundary map", () => {
  it("two repos export edges; sync pull merges them; impact joins across spellings", async () => {
    const ordersDb = join(dir, "orders.db");
    const reportingDb = join(dir, "reporting.db");
    const centralDb = join(dir, "central.db");
    const ordersRepo = join(dir, "orders-svc");
    const reportingRepo = join(dir, "reporting-svc");

    // orders-svc provides OrderSubmitted (camelCase).
    process.env["MEMORY_DB"] = ordersDb;
    await run("init");
    await run("boundary", "add", "orders-svc", "OrderSubmitted", "provides", "--kind", "event");
    await run("sync", "export", join(ordersRepo, ".memory"));

    // reporting-svc consumes order-submitted (kebab).
    process.env["MEMORY_DB"] = reportingDb;
    await run("init");
    await run("boundary", "add", "reporting-svc", "order-submitted", "consumes");
    await run("sync", "export", join(reportingRepo, ".memory"));

    // Central machine pulls everything under dir.
    process.env["MEMORY_DB"] = centralDb;
    await run("init");
    out = "";
    expect(await run("sync", "pull", dir)).toBe(0);
    expect(out).toMatch(/boundary edge/);

    // The map joins the two spellings into one contract.
    out = "";
    expect(await run("impact", "order_submitted")).toBe(0);
    expect(out).toContain("orders-svc");
    expect(out).toContain("reporting-svc");
    expect(out).toMatch(/Providers.*1/s);
    expect(out).toMatch(/Consumers.*1/s);
  });
});

describe("repo understanding — digest + features CLI", () => {
  it("digest <repo> renders overview, structure, conventions + freshness", async () => {
    const { openDb } = await import("../src/db/index.js");
    const { upsertDigest } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    upsertDigest(db, {
      repo: "payments-svc",
      overview: "Captures payments.",
      structure: "src/api, src/core.",
      conventions: "TS strict; zod at boundaries.",
      stack: "TypeScript, Fastify",
      source: "merge:#42",
    });
    db.close();

    expect(await run("digest", "payments-svc")).toBe(0);
    expect(out).toContain("Captures payments.");
    expect(out).toContain("src/api, src/core.");
    expect(out).toContain("zod at boundaries.");
    // Freshness + source line and the honesty caveat.
    expect(out).toMatch(/source: merge:#42/);
    expect(out).toMatch(/updated_at:/);
    expect(out).toMatch(/summary — verify it against the code/);
  });

  it("digest <repo> on an unknown repo explains how to create one", async () => {
    expect(await run("digest", "ghost-repo")).toBe(0);
    expect(out).toMatch(/no digest for 'ghost-repo'/);
  });

  it("digest requires a repo positional", async () => {
    expect(await run("digest")).toBe(2);
    expect(err).toMatch(/requires a repo name/);
  });

  it("features <repo> lists grouped by status, repo-level and node-level", async () => {
    const { openDb } = await import("../src/db/index.js");
    const { addFeature } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    addFeature(db, { repo: "app", name: "Repo idea", summary: "s" });
    addFeature(db, {
      repo: "app",
      scopeNode: "auth",
      name: "Auth login",
      summary: "s",
      status: "shipped",
    });
    db.close();

    expect(await run("features", "app")).toBe(0);
    expect(out).toContain("Repo idea");
    expect(out).toContain("Auth login");
    expect(out).toContain("@auth");
    expect(out).toMatch(/BACKLOG \(1\)/);
    expect(out).toMatch(/SHIPPED \(1\)/);
  });

  it("features --node filters to a single scope-node", async () => {
    const { openDb } = await import("../src/db/index.js");
    const { addFeature } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    addFeature(db, { repo: "app", name: "Repo idea", summary: "s" });
    addFeature(db, {
      repo: "app",
      scopeNode: "auth",
      name: "Auth login",
      summary: "s",
    });
    db.close();

    out = "";
    expect(await run("features", "app", "--node", "auth")).toBe(0);
    expect(out).toContain("Auth login");
    expect(out).not.toContain("Repo idea");
    expect(out).toMatch(/Features for app @auth/);
  });

  it("features --status filters and rejects a bad status", async () => {
    const { openDb } = await import("../src/db/index.js");
    const { addFeature } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    addFeature(db, { repo: "app", name: "A", summary: "s" });
    addFeature(db, {
      repo: "app",
      name: "B",
      summary: "s",
      status: "shipped",
    });
    db.close();

    out = "";
    expect(await run("features", "app", "--status", "shipped")).toBe(0);
    expect(out).toContain("B");
    expect(out).not.toContain("[backlog]");

    err = "";
    expect(await run("features", "app", "--status", "nope")).toBe(2);
    expect(err).toMatch(/--status must be/);
  });

  it("features on a repo with none reports empty", async () => {
    expect(await run("features", "empty-repo")).toBe(0);
    expect(out).toMatch(/no features for 'empty-repo'/);
  });
});

describe("repo understanding — write verbs (digest set/touch, feature add/advance)", () => {
  async function readDigest(repo: string) {
    const { openDb } = await import("../src/db/index.js");
    const { getDigest } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    try {
      return getDigest(db, repo);
    } finally {
      db.close();
    }
  }

  it("digest set creates a digest when all sections are given", async () => {
    expect(
      await run(
        "digest",
        "set",
        "svc",
        "--overview",
        "Does X.",
        "--structure",
        "src/a, src/b",
        "--conventions",
        "strict TS",
        "--stack",
        "TypeScript",
        "--source",
        "onboard",
      ),
    ).toBe(0);
    expect(out).toMatch(/created digest for svc/);
    const d = await readDigest("svc");
    expect(d?.overview).toBe("Does X.");
    expect(d?.stack).toBe("TypeScript");
    expect(d?.source).toBe("onboard");
  });

  it("digest set is a PARTIAL MERGE — unpassed sections keep their prior value", async () => {
    expect(
      await run(
        "digest",
        "set",
        "svc",
        "--overview",
        "v1",
        "--structure",
        "s1",
        "--conventions",
        "c1",
        "--stack",
        "k1",
        "--source",
        "onboard",
      ),
    ).toBe(0);

    out = "";
    // Update ONLY overview + source; structure/conventions/stack must survive.
    expect(await run("digest", "set", "svc", "--overview", "v2", "--source", "merge:#7")).toBe(0);
    expect(out).toMatch(/updated digest for svc/);
    expect(out).toMatch(/overview/);

    const d = await readDigest("svc");
    expect(d?.overview).toBe("v2"); // changed
    expect(d?.structure).toBe("s1"); // preserved
    expect(d?.conventions).toBe("c1"); // preserved
    expect(d?.stack).toBe("k1"); // preserved
    expect(d?.source).toBe("merge:#7"); // re-stamped
  });

  it("digest set refuses a partial FIRST set (nothing to merge from)", async () => {
    expect(
      await run("digest", "set", "fresh-repo", "--overview", "only this", "--source", "merge:#1"),
    ).toBe(2);
    expect(err).toMatch(/first set must include every section/);
    expect(await readDigest("fresh-repo")).toBeNull();
  });

  it("digest set requires --source", async () => {
    expect(await run("digest", "set", "svc", "--overview", "x")).toBe(2);
    expect(err).toMatch(/requires --source/);
  });

  it("digest set requires at least one section", async () => {
    expect(await run("digest", "set", "svc", "--source", "merge:#1")).toBe(2);
    expect(err).toMatch(/at least one section/);
  });

  it("digest touch re-stamps source/updated_at and leaves content", async () => {
    expect(
      await run(
        "digest",
        "set",
        "svc",
        "--overview",
        "keep me",
        "--structure",
        "s",
        "--conventions",
        "c",
        "--stack",
        "k",
        "--source",
        "onboard",
      ),
    ).toBe(0);
    const before = await readDigest("svc");

    out = "";
    expect(await run("digest", "touch", "svc", "--source", "merge:#9")).toBe(0);
    expect(out).toMatch(/touched digest for svc/);
    const after = await readDigest("svc");
    expect(after?.overview).toBe("keep me"); // content untouched
    expect(after?.source).toBe("merge:#9"); // source re-stamped
    expect(after?.updatedAt).not.toBe(before?.updatedAt); // freshness bumped
  });

  it("digest touch refuses when no digest exists yet", async () => {
    expect(await run("digest", "touch", "ghost", "--source", "merge:#1")).toBe(1);
    expect(err).toMatch(/no digest for 'ghost' to touch/);
  });

  it("feature add lands a backlog feature by default", async () => {
    expect(await run("feature", "add", "app", "--name", "Search", "--summary", "fts")).toBe(0);
    expect(out).toMatch(/added feature/);
    expect(out).toMatch(/\[backlog\] Search/);

    out = "";
    expect(await run("features", "app")).toBe(0);
    expect(out).toContain("Search");
    expect(out).toMatch(/BACKLOG \(1\)/);
  });

  it("feature add honours --status, --scope-node and --provenance", async () => {
    expect(
      await run(
        "feature",
        "add",
        "app",
        "--name",
        "Login",
        "--summary",
        "oauth",
        "--status",
        "building",
        "--scope-node",
        "auth",
        "--provenance",
        "epic-7",
      ),
    ).toBe(0);
    expect(out).toMatch(/\[building\] Login @auth/);
  });

  it("feature add rejects a bad --status", async () => {
    expect(
      await run("feature", "add", "app", "--name", "X", "--summary", "s", "--status", "nope"),
    ).toBe(2);
    expect(err).toMatch(/--status must be/);
  });

  it("feature add requires --name and --summary", async () => {
    expect(await run("feature", "add", "app", "--summary", "s")).toBe(2);
    expect(err).toMatch(/requires --name/);
    err = "";
    expect(await run("feature", "add", "app", "--name", "X")).toBe(2);
    expect(err).toMatch(/requires --summary/);
  });

  it("feature advance moves through legal transitions", async () => {
    const { openDb } = await import("../src/db/index.js");
    const { addFeature } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    const f = addFeature(db, { repo: "app", name: "F", summary: "s" });
    db.close();

    expect(await run("feature", "advance", f.id, "--to", "building")).toBe(0);
    expect(out).toMatch(/advanced feature .* → building/);

    out = "";
    expect(await run("feature", "advance", f.id, "--to", "shipped")).toBe(0);
    expect(out).toMatch(/→ shipped/);
  });

  it("feature advance REJECTS an illegal transition (shipped → backlog)", async () => {
    const { openDb } = await import("../src/db/index.js");
    const { addFeature } = await import("../src/core/repoUnderstanding.js");
    const db = openDb();
    const f = addFeature(db, {
      repo: "app",
      name: "F",
      summary: "s",
      status: "shipped",
    });
    db.close();

    expect(await run("feature", "advance", f.id, "--to", "backlog")).toBe(2);
    expect(err).toMatch(/not a legal transition/);
  });

  it("feature advance reports an unknown id distinctly (exit 1)", async () => {
    expect(await run("feature", "advance", "no-such-id", "--to", "shipped")).toBe(1);
    expect(err).toMatch(/no feature with id/);
  });

  it("feature advance requires a valid --to", async () => {
    expect(await run("feature", "advance", "some-id", "--to", "nope")).toBe(2);
    expect(err).toMatch(/requires --to/);
  });

  it("feature with no subcommand explains usage", async () => {
    expect(await run("feature")).toBe(2);
    expect(err).toMatch(/feature requires a subcommand/);
  });
});

// ── file-card refresh verbs: delete-file-card + get-card-watermark ────────
describe("CLI — delete-file-card + get-card-watermark (incremental refresh seam)", () => {
  const CANONICAL = "/repos/app";
  const REPO = "app";

  /** Seed one card via the CLI upsert verb (reads the file off disk). */
  async function seedCard(relPath: string): Promise<void> {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "export const x = 1;\n");
    out = "";
    const code = await run(
      "card",
      "upsert",
      "--canonical",
      CANONICAL,
      "--repo",
      REPO,
      "--repo-root",
      dir,
      "--path",
      relPath,
      "--json",
    );
    expect(code).toBe(0);
  }

  it("get-card-watermark returns null before any sync, then the stored commit after", async () => {
    // Absent → syncedCommit:null, exit 0 (absence is a valid answer).
    expect(
      await run("get-card-watermark", "--canonical", CANONICAL, "--repo", REPO, "--json"),
    ).toBe(0);
    expect(JSON.parse(out).syncedCommit).toBeNull();

    // Record a watermark, then read it back through the verb.
    expect(
      await run("card", "sync", "--canonical", CANONICAL, "--repo", REPO, "--commit", "deadbeef"),
    ).toBe(0);
    out = "";
    expect(
      await run("get-card-watermark", "--canonical", CANONICAL, "--repo", REPO, "--json"),
    ).toBe(0);
    expect(JSON.parse(out).syncedCommit).toBe("deadbeef");
  });

  it("delete-file-card removes an existing card, then reports a no-op on a second call", async () => {
    await seedCard("src/gone.ts");
    // Present before the delete.
    out = "";
    expect(
      await run(
        "card",
        "get",
        "--canonical",
        CANONICAL,
        "--repo",
        REPO,
        "--path",
        "src/gone.ts",
        "--json",
      ),
    ).toBe(0);
    expect(JSON.parse(out).found).toBe(true);

    // Delete removes it.
    out = "";
    expect(
      await run(
        "delete-file-card",
        "--canonical",
        CANONICAL,
        "--repo",
        REPO,
        "--path",
        "src/gone.ts",
        "--json",
      ),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, deleted: true });

    // Gone afterwards.
    out = "";
    expect(
      await run(
        "card",
        "get",
        "--canonical",
        CANONICAL,
        "--repo",
        REPO,
        "--path",
        "src/gone.ts",
        "--json",
      ),
    ).toBe(0);
    expect(JSON.parse(out).found).toBe(false);

    // Second delete is a no-op (deleted:false) but still exit 0.
    out = "";
    expect(
      await run(
        "delete-file-card",
        "--canonical",
        CANONICAL,
        "--repo",
        REPO,
        "--path",
        "src/gone.ts",
        "--json",
      ),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, deleted: false });
  });

  it("delete-file-card requires --path", async () => {
    expect(await run("delete-file-card", "--canonical", CANONICAL, "--repo", REPO)).toBe(2);
    expect(err).toMatch(/requires --path/);
  });
});

describe("CLI — memory feedback loop (recall-feedback + flagged)", () => {
  const CANONICAL = "/repos/app";
  const REPO = "app";

  async function seedLore(): Promise<string> {
    // Distinctive token so cards-for-scope FTS reliably serves it.
    const rc = await run(
      "add",
      "--title",
      "Zorptastic hashing rule",
      "--summary",
      "zorptastic default policy",
      "--body",
      "always zorptastic",
      "--repo",
      REPO,
      "--confidence",
      "low",
    );
    expect(rc).toBe(0);
    return firstId(out);
  }

  it("logs served items via cards-for-scope --ticket, then clean bumps confidence", async () => {
    const id = await seedLore();
    out = "";
    // Serve the lore into ticket 42's context (recall edge logged).
    expect(
      await run(
        "cards-for-scope",
        "--canonical",
        CANONICAL,
        "--repo",
        REPO,
        "--query",
        "zorptastic",
        "--ticket",
        "42",
        "--json",
      ),
    ).toBe(0);
    const packet = JSON.parse(out);
    expect(packet.lore.some((l: { id: string }) => l.id === id)).toBe(true);

    out = "";
    expect(
      await run(
        "recall-feedback",
        "--repo",
        REPO,
        "--ticket",
        "42",
        "--outcome",
        "clean",
        "--json",
      ),
    ).toBe(0);
    const res = JSON.parse(out);
    expect(res.alreadyApplied).toBe(false);
    expect(res.loreAdjusted).toContain(id);

    // Confidence bumped low → medium; shows in `show`.
    out = "";
    await run("show", id);
    expect(out).toMatch(/conf=medium/);
  });

  it("blocked flags the served lore and surfaces it via `flagged`", async () => {
    const id = await seedLore();
    out = "";
    await run(
      "cards-for-scope",
      "--canonical",
      CANONICAL,
      "--repo",
      REPO,
      "--query",
      "zorptastic",
      "--ticket",
      "7",
      "--json",
    );
    out = "";
    expect(
      await run(
        "recall-feedback",
        "--repo",
        REPO,
        "--ticket",
        "7",
        "--outcome",
        "blocked",
        "--json",
      ),
    ).toBe(0);

    out = "";
    expect(await run("flagged", "--repo", REPO, "--json")).toBe(0);
    const items = JSON.parse(out);
    expect(items.some((i: { id: string; type: string }) => i.id === id && i.type === "lore")).toBe(
      true,
    );
  });

  it("recall-feedback is idempotent per (ticket, outcome)", async () => {
    await seedLore();
    await run(
      "cards-for-scope",
      "--canonical",
      CANONICAL,
      "--repo",
      REPO,
      "--query",
      "zorptastic",
      "--ticket",
      "3",
      "--json",
    );
    await run("recall-feedback", "--repo", REPO, "--ticket", "3", "--outcome", "clean", "--json");
    out = "";
    expect(
      await run("recall-feedback", "--repo", REPO, "--ticket", "3", "--outcome", "clean", "--json"),
    ).toBe(0);
    expect(JSON.parse(out).alreadyApplied).toBe(true);
  });

  it("recall-feedback rejects a bad --outcome and missing flags", async () => {
    expect(await run("recall-feedback", "--repo", REPO, "--ticket", "1", "--outcome", "nope")).toBe(
      2,
    );
    expect(err).toMatch(/--outcome/);
    err = "";
    expect(await run("recall-feedback", "--ticket", "1", "--outcome", "clean")).toBe(2);
    expect(err).toMatch(/--repo/);
  });

  it("flagged reports nothing when there is nothing to review", async () => {
    out = "";
    expect(await run("flagged", "--repo", REPO)).toBe(0);
    expect(out).toMatch(/No items flagged for review/);
  });

  it("recall-stats reports a zero-state when nothing has been recorded", async () => {
    out = "";
    expect(await run("recall-stats", "--json")).toBe(0);
    const stats = JSON.parse(out);
    expect(stats.total).toBe(0);
    expect(stats.effectiveness_pct).toBeNull();
    expect(stats.by_day).toEqual([]);
  });

  it("recall-stats rolls up outcomes after a served ticket is scored", async () => {
    const id = await seedLore();
    // Serve the lore into ticket 7, then score it clean.
    expect(
      await run(
        "cards-for-scope",
        "--canonical",
        CANONICAL,
        "--repo",
        REPO,
        "--query",
        "zorptastic",
        "--ticket",
        "7",
        "--json",
      ),
    ).toBe(0);
    expect(
      await run("recall-feedback", "--repo", REPO, "--ticket", "7", "--outcome", "clean"),
    ).toBe(0);

    out = "";
    expect(await run("recall-stats", "--repo", REPO, "--json")).toBe(0);
    const stats = JSON.parse(out);
    expect(stats.total).toBe(1);
    expect(stats.clean).toBe(1);
    expect(stats.effectiveness_pct).toBe(100);
    expect(stats.by_day.length).toBe(1);

    // Human (non-JSON) form renders a readable summary.
    out = "";
    expect(await run("recall-stats", "--repo", REPO)).toBe(0);
    expect(out).toMatch(/RECALL EFFECTIVENESS/);
    expect(out).toMatch(/effectiveness: 100% clean/);
    void id;
  });
});
