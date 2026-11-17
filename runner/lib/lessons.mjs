// LESSONS FROM EARLIER CHANGES HERE (backlog 59), for the runner's node entry points (the
// independent tester, bin/tester-run.mjs). The bash twin is gaffer_lessons_block in
// lib/context-primer.sh; both call the same two programs, so the block is the same:
//   1. `memory lessons --repo <r> --paths=<p>... --json`: the APPROVED lessons of the repo
//      whose paths overlap the given ones (memory core/lessons.ts; never by text);
//   2. crew's renderContextPrimerCli.js --kind lessons --audience <a>: the block, with the
//      lesson text quoted inside <untrusted-lessons> (it is a person's report, untrusted).
// FAIL-SOFT: no repo, no path, a missing program, an error or no match gives "" and the
// caller proceeds exactly as before. Never logged for recall feedback.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Most paths one lookup sends (the delivery and the reviewer send at most 50 too). */
export const LESSON_PATHS_MAX = 50;

/**
 * The paths a delivered change touched: `git diff --name-only <base>...<head>` in the real
 * repo, run by the runner (the agent never runs it). Empty on any git error.
 */
export function changedPaths(repoPath, base, head) {
  if (!repoPath || !base || !head || !existsSync(repoPath)) return [];
  const r = spawnSync(
    "git",
    ["-C", repoPath, "diff", "--name-only", "--no-renames", `${base}...${head}`],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (r.status !== 0) return [];
  return [
    ...new Set(
      String(r.stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ].slice(0, LESSON_PATHS_MAX);
}

/**
 * The rendered "Lessons from earlier changes here" block, or "".
 * @param {{memoryCliBin: string, memoryDb: string, crewDir: string, repo: string,
 *          paths: string[], audience?: "delivery"|"review"|"tester"}} o
 */
export function lessonsBlock(o) {
  const repo = String(o?.repo ?? "").trim();
  const paths = (Array.isArray(o?.paths) ? o.paths : [])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .slice(0, LESSON_PATHS_MAX);
  if (!repo || paths.length === 0) return "";
  const render = resolve(o.crewDir || "", "dist/runtime/context/renderContextPrimerCli.js");
  if (!o.memoryCliBin || !existsSync(o.memoryCliBin) || !existsSync(render)) return "";
  // `--paths=<p>`: a path that starts with `-` stays a value.
  const argv = [
    o.memoryCliBin,
    "lessons",
    "--repo",
    repo,
    "--json",
    ...paths.map((p) => `--paths=${p}`),
  ];
  const got = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MEMORY_DB: o.memoryDb },
  });
  const json = got.status === 0 ? String(got.stdout || "").trim() : "";
  if (!json || json === "[]") return "";
  const audience = o.audience === "review" || o.audience === "delivery" ? o.audience : "tester";
  const out = spawnSync(process.execPath, [render, "--kind", "lessons", "--audience", audience], {
    encoding: "utf8",
    input: json,
    timeout: 20_000,
  });
  return out.status === 0 ? String(out.stdout || "") : "";
}
