import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Dispatch } from "../core.js";
import type { ResearchRun } from "../services/researchService.js";
import { lastIsolationStatus } from "./isolation.js";
import { spendCapRefusalAsync } from "./pollWork.js";

/**
 * The seam between dispatch and the runner's research launcher (backlog 69).
 *
 * Starting a run stores it `running` (services/researchService.ts startRun) and spawns
 * `node runner/bin/research-run.mjs` with `{ idea, repo? }` on stdin, in the background:
 * the request returns at once with the run, and the dashboard polls it. When the
 * launcher exits, its one JSON object is stored (completeRun) or its error recorded
 * (failRun). The launcher builds the agent's environment itself from an allowlist; this
 * spawn hands it dispatch's environment minus the API token, exactly as the spec author
 * is spawned. No request text reaches a command line: the idea travels on stdin.
 *
 * A run whose launcher is gone (the server restarted mid-run) is marked failed the next
 * time it is read, once it is older than the launcher's own timeout plus a grace.
 */

/** Env var overriding the launcher path (tests point it at a stub). */
export const GAFFER_RESEARCH_BIN_ENV = "GAFFER_RESEARCH_BIN";
export const DEFAULT_RESEARCH_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "runner",
  "bin",
  "research-run.mjs",
);
/** The launcher's own wall clock is 15 minutes; dispatch kills it a minute later. */
export const RESEARCH_KILL_MS = 16 * 60 * 1000;
/** A `running` row older than this with no launcher in this process is failed. */
export const RESEARCH_STALE_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4_000_000;

const live = new Set<string>();

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _t, GAFFER_PRINCIPAL_TOKEN: _p, ...rest } = env;
  void _t;
  void _p;
  return rest;
}

/**
 * Why a research run cannot start on this host right now (the checkbox's disabled
 * reason), or null. The same rules the launcher applies, asked early: a dollar cap (the
 * admission rule every paid launch passes) and a usable OS sandbox (research never runs
 * unwrapped, the opt-out included).
 */
export async function researchUnavailableReason(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const cap = await spendCapRefusalAsync(env);
  if (cap !== null) return `Research is a paid run and needs a dollar cap first. ${cap}`;
  const iso = lastIsolationStatus();
  if (iso !== null) {
    if (!iso.available) {
      return `Research runs only inside an OS sandbox, and this host has none right now${iso.missing ? `: ${iso.missing}` : ""}.`;
    }
    if (iso.optedOut && (env["STRICT_MODE"] ?? "").trim() !== "1") {
      return "Research runs only inside an OS sandbox; GAFFER_STRICT_REQUIRE=0 switched it off for this factory.";
    }
  }
  return null;
}

/** Start the launcher for a stored `running` run; resolves when it has been recorded. */
export function launchResearch(
  wg: Dispatch,
  run: ResearchRun,
  opts: { overview?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResearchRun> {
  const env = opts.env ?? process.env;
  const bin = (env[GAFFER_RESEARCH_BIN_ENV] ?? "").trim() || DEFAULT_RESEARCH_BIN;
  const payload = JSON.stringify({
    idea: run.idea,
    ...(run.repo
      ? { repo: { name: run.repo, ...(run.share_overview && opts.overview ? { overview: opts.overview } : {}) } }
      : {}),
  });
  live.add(run.id);
  return new Promise<ResearchRun>((resolve) => {
    let settled = false;
    const finish = (fn: () => ResearchRun): void => {
      if (settled) return;
      settled = true;
      live.delete(run.id);
      let out: ResearchRun;
      try {
        out = fn();
      } catch {
        out = wg.researchSvc.getRun(run.id);
      }
      resolve(out);
    };
    let child;
    try {
      child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"], env: childEnv(env) });
    } catch (e) {
      finish(() => wg.researchSvc.failRun(run.id, `could not start the research launcher: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => wg.researchSvc.failRun(run.id, "the research launcher timed out"));
    }, RESEARCH_KILL_MS);
    timer.unref?.();
    child.stdout?.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (errText.length < 4000) errText += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      finish(() => wg.researchSvc.failRun(run.id, `the research launcher failed to run: ${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const obj = parseLastLine(text);
      if (obj !== null && obj.phase === "research") {
        finish(() => wg.researchSvc.completeRun(run.id, obj));
      } else if (obj !== null && obj.phase === "error") {
        finish(() => wg.researchSvc.failRun(run.id, String(obj.error ?? "the research run failed")));
      } else {
        finish(() =>
          wg.researchSvc.failRun(
            run.id,
            bytes > MAX_OUTPUT_BYTES
              ? "the research launcher produced too much output"
              : `the research launcher returned no result${errText.trim() ? `: ${errText.trim().slice(0, 300)}` : ""}`,
          ),
        );
      }
    });
    child.stdin?.on("error", () => {
      /* surfaces through close */
    });
    child.stdin?.end(payload);
  });
}

/** The launcher's one JSON object (its last stdout line), or null. */
export function parseLastLine(text: string): { phase?: unknown; error?: unknown } | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text.split("\n").pop() ?? "");
    return v !== null && typeof v === "object" ? (v as { phase?: unknown; error?: unknown }) : null;
  } catch {
    return null;
  }
}

/** A `running` run whose launcher is not alive here and that is past the stale age: failed. */
export function reapStaleResearch(wg: Dispatch, run: ResearchRun, now = Date.now()): ResearchRun {
  if (run.status !== "running" || live.has(run.id)) return run;
  if (now - Date.parse(run.created_at) < RESEARCH_STALE_MS) return run;
  return wg.researchSvc.failRun(run.id, "the research run was interrupted (its launcher is gone); start a new one");
}

/** For tests: is a launcher for this run alive in this process? */
export function researchLive(id: string): boolean {
  return live.has(id);
}
