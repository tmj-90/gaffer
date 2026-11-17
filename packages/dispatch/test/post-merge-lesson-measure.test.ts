/**
 * LESSONS, MEASURED (backlog 59, part 5): per lesson, the changes that landed on its paths
 * and how many later had something go wrong, before vs after it went live; no rate below
 * the minimum n; the report's totals (live, drafts waiting, recurrences after: k of n).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import {
  LESSON_MEASURE_MIN_CHANGES,
  lessonMeasure,
  lessonPathOverlaps,
  type LandedChange,
} from "../src/health/lessons.js";
import { lessonsReport } from "../src/services/lessonReportService.js";
import { FINDING_LESSON_EVENT } from "../src/services/findingService.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const DAY = 86_400_000;
const A = Date.parse("2026-06-01T00:00:00.000Z");

describe("lessonPathOverlaps (the rule memory serves lessons by)", () => {
  it.each([
    ["src/export/csv.ts", "src/export/csv.ts", true],
    ["src/export/", "src/export/xlsx.ts", true],
    ["src/export", "src/export/xlsx.ts", true],
    ["src/export/csv.ts", "src/export", true],
    ["src/a", "src/ab.ts", false],
    ["src/**/*.test.ts", "src/x/y/z.test.ts", true],
    ["src/*.ts", "src/x/y.ts", false],
    ["src/export/*.ts", "src/", true],
    ["../x", "../x", false],
    ["./src/a.ts", "src/a.ts", true],
  ])("%s vs %s -> %s", (l, t, want) => {
    expect(lessonPathOverlaps(l, t)).toBe(want);
  });

  // The review's hostile set (backlog 59 review): this copy and memory's own rule must
  // agree on every pair, or the measure counts changes memory never served the lesson to.
  const HOSTILE = [
    "src/a/x.ts",
    "src/a",
    "src/a/",
    "src/ab.ts",
    "./src/a/x.ts",
    "/src/a/x.ts",
    "src//a/x.ts",
    "src\\a\\x.ts",
    "SRC/a/x.ts",
    "src/../src/a/x.ts",
    "..",
    "../x",
    ".",
    "./",
    "/",
    "",
    " ",
    "**",
    "*",
    "**/*",
    "src/**",
    "src/*",
    "src/a/*.ts",
    "src/**/x.ts",
    "?",
    "[",
    "src/[a]/x.ts",
    "src/a b/x.ts",
    "src/a\nb.ts",
    "src/a\u0000.ts",
    "src/(a)/x.ts",
    "src/a.ts/",
    "a".repeat(501),
    " src/a/x.ts",
    "./././src/a",
    "src/./a/x.ts",
    "src/a/..",
    "src/é.ts",
  ];
  const MEMORY_LESSONS = join(__dirname, "..", "..", "memory", "dist", "core", "lessons.js");
  it.skipIf(!existsSync(MEMORY_LESSONS))(
    "agrees with memory's pathsOverlap on every pair",
    async () => {
      const memory = (await import(MEMORY_LESSONS)) as {
        pathsOverlap: (l: string, t: string) => boolean;
      };
      const differ: string[] = [];
      for (const l of HOSTILE)
        for (const t of HOSTILE)
          if (memory.pathsOverlap(l, t) !== lessonPathOverlaps(l, t))
            differ.push(`${JSON.stringify(l).slice(0, 40)} ~ ${JSON.stringify(t).slice(0, 40)}`);
      expect(differ).toEqual([]);
    },
  );
  it("refuses what memory refuses: `.`, control characters, over 500 characters", () => {
    expect(lessonPathOverlaps(".", ".")).toBe(false);
    expect(lessonPathOverlaps("**", "src/a\u0000.ts")).toBe(false);
    expect(lessonPathOverlaps("*", "a".repeat(501))).toBe(false);
  });
});

const change = (
  id: string,
  daysFromA: number,
  recurred: boolean,
  paths = ["src/export/csv.ts"],
  repo = "app",
): LandedChange => ({ ticketId: id, repo, landedAtMs: A + daysFromA * DAY, paths, recurred });

describe("lessonMeasure", () => {
  const now = A + 10 * DAY;
  it("not approved: not measured", () => {
    const m = lessonMeasure({
      repo: "app",
      paths: ["src/export/"],
      sourceTicketId: "src",
      approvedAtMs: null,
      changes: [change("x", 1, true)],
      nowMs: now,
    });
    expect(m.state).toBe("not_approved");
    expect(m.changes_after).toBe(0);
  });

  it("counts changes and recurrences on its paths in equal windows; rates only at the minimum n", () => {
    const before = [
      change("b1", -1, true),
      change("b2", -2, true),
      change("b3", -3, true),
      change("b4", -4, false),
      change("b5", -5, false),
      change("b6", -9, false),
      change("old", -11, true), // outside the before window (10 days)
    ];
    const after = [
      change("a1", 1, true),
      change("a2", 2, false),
      change("a3", 3, false),
      change("a4", 4, false),
      change("a5", 5, false),
    ];
    const noise = [
      change("other-path", 2, true, ["src/billing/x.ts"]),
      change("other-repo", 2, true, ["src/export/csv.ts"], "svc"),
      change("src", -20, true), // the lesson's own change
      change("future", 11, true), // after now
    ];
    const m = lessonMeasure({
      repo: "app",
      paths: ["src/export/"],
      sourceTicketId: "src",
      approvedAtMs: A,
      changes: [...before, ...after, ...noise],
      nowMs: now,
    });
    expect(m).toMatchObject({
      state: "measured",
      window_days: 10,
      changes_before: 6,
      recurrences_before: 3,
      rate_before_pct: 50,
      changes_after: 5,
      recurrences_after: 1,
      rate_after_pct: 20,
    });
    expect(m.note).toBe(
      "Since it went live, 1 of 5 changes on its paths had something go wrong after they were done.",
    );
    expect([...m.after_ids].sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(m.after_recurred_ids).toEqual(["a1"]);
  });

  it(`below ${LESSON_MEASURE_MIN_CHANGES} changes on a side: counts, no rate`, () => {
    const m = lessonMeasure({
      repo: "app",
      paths: ["src/export/csv.ts"],
      sourceTicketId: "src",
      approvedAtMs: A,
      changes: [change("a1", 1, true), change("b1", -1, false)],
      nowMs: now,
    });
    expect(m).toMatchObject({
      state: "not_enough_data",
      changes_after: 1,
      recurrences_after: 1,
      rate_after_pct: null,
      changes_before: 1,
      rate_before_pct: null,
    });
    expect(m.note).toBe(
      `1 change on its paths since it went live: a rate needs ${LESSON_MEASURE_MIN_CHANGES}.`,
    );
  });
});

describe("lessonsReport", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = Dispatch.open(":memory:", new TestClock());
  });
  afterEach(() => wg.db.close());

  /** A ticket on `repo` that landed `day` days from A, its delivery touching `paths`. */
  function landedAt(day: number, paths: string[], repo = "app"): { id: string; number: number } {
    const r = wg.repos.findByName(repo) ?? wg.registerRepository({ name: repo }, human);
    const t = wg.createTicketWithLinks(
      { title: `t${day}`, description: "" },
      { repoAccess: [{ repo_id: r.id, access: "write" }] },
      human,
    );
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: system,
      event_type: "ticket.delivery_recorded",
      payload: { diff_summary: paths.map((p) => ` ${p} | 2 +-`).join("\n") },
    });
    wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
    const ev = writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: system,
      event_type: "ticket.transitioned",
      payload: { from: "ready_for_merge", to: "done" },
    });
    wg.db
      .prepare(`UPDATE work_events SET created_at = ? WHERE id = ?`)
      .run(new Date(A + day * DAY).toISOString(), ev);
    return { id: t.id, number: t.number ?? 0 };
  }

  function lessonOn(t: { id: string }, loreId: string, paths: string[]): void {
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: human,
      event_type: FINDING_LESSON_EVENT,
      payload: { finding_id: `f-${loreId}`, lore_id: loreId, repo: "app", paths },
    });
  }

  it("totals: live, drafts waiting, unknown, and recurrences after counted once over live lessons", () => {
    const source = landedAt(-30, ["src/export/csv.ts"]);
    lessonOn(source, "live0001", ["src/export/"]);
    lessonOn(source, "live0002", ["src/export/csv.ts"]); // overlaps the same changes
    lessonOn(source, "draft001", ["src/export/"]);
    lessonOn(source, "gone0001", ["src/export/"]);
    const a1 = landedAt(1, ["src/export/csv.ts"]);
    landedAt(2, ["src/export/xlsx.ts"]);
    landedAt(3, ["src/billing/x.ts"]);
    // Something went wrong after a1: a finding on it.
    wg.addFinding(a1.id, { text: "broke the header again" }, human);
    const status: Record<string, { status: string; approvedAt: string | null } | null> = {
      live0001: { status: "active", approvedAt: new Date(A).toISOString() },
      live0002: { status: "active", approvedAt: new Date(A).toISOString() },
      draft001: { status: "draft", approvedAt: null },
      gone0001: null,
    };
    const r = lessonsReport(wg.db, {
      nowMs: A + 10 * DAY,
      lookup: (id) => status[id] ?? null,
    });
    expect(r).toMatchObject({ live: 2, drafts_waiting: 1, unknown: 1, min_changes: 5 });
    // live0001 (src/export/) sees a1 and xlsx; live0002 (csv.ts) sees a1: 2 changes once.
    expect(r.recurrences_after).toEqual({ k: 1, n: 2 });
    const l1 = r.lessons.find((l) => l.lore_id === "live0001")!;
    expect(l1).toMatchObject({
      number: source.number,
      repo: "app",
      lore_status: "active",
      measure: { state: "not_enough_data", changes_after: 2, recurrences_after: 1 },
    });
    expect(r.lessons.find((l) => l.lore_id === "draft001")!.measure.state).toBe("not_approved");
    expect(r.lessons.find((l) => l.lore_id === "gone0001")!.lore_status).toBeNull();
    // The panel says what the measure cannot see: paths come from the diff summary.
    expect(r.note).toMatch(/Counts can read low: .*recorded diff summary/);
  });

  it("a regression link on a later change counts as a recurrence; a withdrawn finding does not", () => {
    const source = landedAt(-30, ["src/a.ts"]);
    lessonOn(source, "live0001", ["src/a.ts"]);
    const a1 = landedAt(1, ["src/a.ts"]);
    const a2 = landedAt(2, ["src/a.ts"]);
    const defect = wg.createTicket({ title: "defect", policy_pack: "solo_loose" }, human);
    wg.fileRegression(defect.id, a1.id, human);
    const f = wg.addFinding(a2.id, { text: "wrong but taken back" }, human).finding;
    wg.withdrawFinding(a2.id, f.id, "not real", human);
    const r = lessonsReport(wg.db, {
      nowMs: A + 10 * DAY,
      lookup: () => ({ status: "active", approvedAt: new Date(A).toISOString() }),
    });
    expect(r.recurrences_after).toEqual({ k: 1, n: 2 });
  });
});

describe.skipIf(!CLI_BUILT)("wg lessons", () => {
  it("prints the summary line and, with --json, the report (memory unreachable: unknown)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-lessons-"));
    try {
      const db = join(dir, "dispatch.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: t.id,
        actor: human,
        event_type: FINDING_LESSON_EVENT,
        payload: { finding_id: "f1", lore_id: "abcd2345", repo: "app", paths: ["src/a.ts"] },
      });
      wg.db.close();
      const text = runBin(db, ["lessons"]);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toMatch(
        /^Lessons: 0 live, 0 drafts waiting, recurrences after: 0 of 0\./,
      );
      const json = runBin(db, ["lessons", "--json"]);
      const r = JSON.parse(json.stdout) as { unknown: number; lessons: Array<{ lore_id: string }> };
      expect(r.unknown).toBe(1);
      expect(r.lessons.map((l) => l.lore_id)).toEqual(["abcd2345"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
