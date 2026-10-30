import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { parse as parseYaml } from "yaml";

import { isAuditDisabled, resolveAuditPath } from "../audit/index.js";
import { findInertKeys } from "../config/inertKeys.js";
import { configuredSqlitePath, resolveSqlitePath } from "../config/loader.js";
import { cliConfigFromEnv } from "../memory/cliClient.js";
import { withDispatchRepos } from "../registry/dispatchRepos.js";
import { resolveAsyncMemory, hasRealMemory } from "../memory/factory.js";
import type { FactoryContext } from "../runtime/wiring.js";
import { loadSkillRegistry } from "../skills/loader.js";
import { CrewError } from "../util/errors.js";
import type { DispatchClient } from "../dispatch/client.js";

/**
 * `crew doctor` — an operational pre-flight that answers "is this factory
 * actually ready to run?". Each check is independent and degrades to a `warn`
 * or `fail` with an actionable `fix`, mirroring memory-mcp's doctor. The command
 * exits non-zero only when something is genuinely broken (`fail`), so it slots
 * into CI as a gate.
 */

export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly label: string;
  readonly level: CheckLevel;
  readonly detail?: string;
  /** Actionable remediation, present on warn/fail. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

/** How doctor opens Dispatch (injected so tests can stub reachability). */
export type DispatchProbe = (ctx: FactoryContext) => Promise<DispatchClient>;

export interface DoctorDeps {
  readonly ctx: FactoryContext;
  readonly openDispatch: DispatchProbe;
  /** Override env for audit/memory checks (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
}

function ok(label: string, detail?: string): DoctorCheck {
  return detail ? { label, level: "ok", detail } : { label, level: "ok" };
}

/**
 * Run every readiness check and aggregate. Pure of process exit / printing —
 * the CLI renders and sets the exit code from the returned report.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { ctx } = deps;
  const env = deps.env ?? process.env;
  const checks: DoctorCheck[] = [];

  // 1. Config loaded + valid. (Reaching here means loadFactory already parsed it.)
  checks.push(
    ok("Config valid", `${ctx.loaded.configPath} (mode: ${ctx.loaded.config.factory.mode})`),
  );

  // 2. Dispatch reachable. Probed FIRST: the repo check below merges Dispatch's
  // registry (what onboarding writes), exactly as `crew idle` / `crew maintain` do.
  //
  // `open()` alone is a weak probe: the real client calls `Dispatch.open(path)`,
  // which CREATES the sqlite file (and its schema) when absent. The CLI therefore
  // opens with `mustExist` (a missing file fails here instead of being created),
  // and we issue an actual read query (`listReady`) against the opened store:
  // a locked DB, a corrupt file, or a store whose schema doesn't satisfy the
  // facade surfaces here as a `fail` rather than slipping through.
  let dispatch: DispatchClient | null = null;
  let dispatchCheck: DoctorCheck;
  try {
    const wg = await deps.openDispatch(ctx);
    wg.listReady();
    dispatch = wg;
    dispatchCheck = ok("Dispatch reachable", resolveSqlitePath(ctx.loaded, env));
  } catch (err) {
    const code = err instanceof CrewError ? err.code : "UNKNOWN";
    const missingDb = err instanceof CrewError && typeof err.details.path === "string";
    dispatchCheck = {
      label: "Dispatch reachable",
      level: "fail",
      detail: `${code}: ${err instanceof Error ? err.message : String(err)}`,
      fix: missingDb
        ? "Point crew.yaml's dispatch.local.sqlite_path (or CREW_DISPATCH_DB) at the factory's DB."
        : code === "DISPATCH_UNAVAILABLE"
          ? "Build the dispatch package first: `pnpm -C ../dispatch build`."
          : "Check the configured dispatch sqlite_path is reachable, not locked, and schema-initialised.",
    };
  }

  // 3. Repos resolve to real directories on disk (crew.yaml + Dispatch).
  const registry = dispatch ? withDispatchRepos(ctx.repoRegistry, dispatch) : ctx.repoRegistry;
  const repos = registry.list();
  if (repos.length === 0) {
    checks.push({
      label: "Repos configured",
      level: "warn",
      detail: "no repositories onboarded (none in Dispatch or crew.yaml)",
      fix: "Onboard a repo: `gaffer onboard <path>` (or `dispatch repo add`).",
    });
  } else {
    const missing = repos.filter((r) => !existsDir(registry.absolutePath(r)));
    if (missing.length === 0) {
      checks.push(ok("Repos resolve", `${repos.length} repo(s) present on disk`));
    } else {
      checks.push({
        label: "Repos resolve",
        level: "fail",
        detail: `${missing.length} of ${repos.length} repo path(s) missing: ${missing
          .map((r) => r.id)
          .join(", ")}`,
        fix: "Fix each repo's path (Dispatch's local_path, or `path` in crew.yaml, which resolves against the config dir).",
      });
    }
  }

  // 4. Agents. Only the mock `crew run` loop routes work to crew.yaml agents; the
  // live runner never reads them, so none configured is informational, never a warn.
  const active = ctx.agentRegistry.active();
  checks.push(
    ok(
      "Active agents",
      active.length === 0
        ? `${ctx.agentRegistry.list().length} configured, 0 active (only needed for \`crew run\`)`
        : `${active.length} active`,
    ),
  );

  checks.push(dispatchCheck);
  // crew.yaml's own sqlite_path vs the DB actually opened (CREW_DISPATCH_DB, which
  // the runner's fg sets to $DISPATCH_DB). A mismatch means crew.yaml has drifted.
  const configured = configuredSqlitePath(ctx.loaded);
  const effective = resolveSqlitePath(ctx.loaded, env);
  if (configured !== effective) {
    checks.push({
      label: "crew.yaml points at the factory DB",
      level: "warn",
      detail: `crew.yaml sqlite_path ${configured} ≠ factory DB ${effective} (using the factory DB via CREW_DISPATCH_DB)`,
      fix: `Set dispatch.local.sqlite_path: ${effective} in crew.yaml, so a direct crew call opens the same DB.`,
    });
  }

  // 5. Memory reachable (optional subsystem).
  if (!hasRealMemory(ctx.loaded.config)) {
    // The factory's real memory path is the CLI bridge (MEMORY_CLI_BIN + MEMORY_DB,
    // or memory.cli.command), not an MCP server.
    const cli = cliConfigFromEnv(env);
    const configuredCli = ctx.loaded.config.memory.cli.command;
    checks.push(
      cli || configuredCli
        ? ok("Memory", `memory CLI bridge (${cli ? "MEMORY_CLI_BIN" : "memory.cli.command"})`)
        : ok("Memory", "not configured (using offline Null client)"),
    );
  } else {
    const lore = await resolveAsyncMemory(ctx.loaded.config);
    if (lore) {
      await lore.close();
      checks.push(ok("Memory reachable", "MCP server connected"));
    } else {
      checks.push({
        label: "Memory reachable",
        level: "warn",
        detail: "configured but the MCP server did not connect",
        fix: "Check `memory.mcp.command`/`args`; the factory degrades to offline lore until it connects.",
      });
    }
  }

  // 6. Skills loaded.
  const skills = loadSkillRegistry({ factoryDir: ctx.loaded.rootDir }).list();
  if (skills.length === 0) {
    checks.push({
      label: "Skills loaded",
      level: "warn",
      detail: "no skills available",
      fix: "Expected built-in skills to load; check the skills registry build.",
    });
  } else {
    checks.push(ok("Skills loaded", `${skills.length} skill(s)`));
  }

  // 7. Safety policy sanity — a policy that allows everything is a red flag.
  checks.push(safetyPolicyCheck(ctx));

  // 8. Audit log status.
  checks.push(auditCheck(ctx, env));

  // 9. crew.yaml keys the live runner never reads.
  checks.push(inertKeysCheck(ctx));

  const failed = checks.some((c) => c.level === "fail");
  return { ok: !failed, checks };
}

/** The branch prefix the runner gives every delivery branch (gaffer/ticket-<N>-<slug>). */
export const RUNNER_BRANCH_PREFIX = "gaffer/";

function safetyPolicyCheck(ctx: FactoryContext): DoctorCheck {
  // safety_policy.yaml is ADVISORY: crew's classifier + the mock `crew run` loop
  // read it; the live PreToolUse hook (runner/safety-hook.mjs) does not. Say so,
  // so a "sane" here is never read as "the factory enforces this".
  const label = "Safety policy (advisory) sane";
  const scope = "advisory only — the live hook (runner/safety-hook.mjs) does not read it";
  const { git, secrets } = ctx.policy;
  const concerns: string[] = [];
  if (!git.deny_force_push) concerns.push("force-push not denied");
  if (!git.deny_push_to_protected_branches) concerns.push("push to protected branches not denied");
  if (!secrets.redact_in_context) concerns.push("secret redaction in context is OFF");
  if (git.protected_branches.length === 0) concerns.push("no protected branches");
  if (!RUNNER_BRANCH_PREFIX.startsWith(git.require_branch_prefix)) {
    concerns.push(
      `require_branch_prefix '${git.require_branch_prefix}' does not match the runner's ` +
        `'${RUNNER_BRANCH_PREFIX}ticket-<N>-<slug>' branches, so every real delivery branch reads as denied`,
    );
  }
  if (concerns.length === 0) {
    return ok(label, `force-push denied, protected branches set, secrets redacted (${scope})`);
  }
  return {
    label,
    level: "warn",
    detail: `${concerns.join("; ")} (${scope})`,
    fix: `Review safety_policy.yaml (set git.require_branch_prefix: ${RUNNER_BRANCH_PREFIX}). It shapes crew's advisory answers; the live factory's boundary is runner/safety-hook.mjs.`,
  };
}

/**
 * Name crew.yaml keys that have no effect on the live factory (see
 * config/inertKeys.ts). Left at their scaffolded value they are harmless and
 * reported as ok; set deliberately (e.g. `definition_of_done.tests: false`) the
 * operator expects an effect they will not get, so that is a warn.
 */
function inertKeysCheck(ctx: FactoryContext): DoctorCheck {
  const label = "crew.yaml keys in effect";
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(ctx.loaded.configPath, "utf8"));
  } catch {
    return ok(label, "could not re-read crew.yaml to check for unread keys");
  }
  const hits = findInertKeys(raw);
  const deliberate = hits.filter((h) => h.deliberate);
  if (deliberate.length > 0) {
    return {
      label,
      level: "warn",
      detail: deliberate
        .map(
          (h) => `${h.at}=${JSON.stringify(h.value)} has no effect (${h.key.scope}: ${h.key.note})`,
        )
        .join("; "),
      fix: "These settings do nothing in the live factory. Delete them, or use the replacement named above.",
    };
  }
  if (hits.length > 0) {
    return ok(
      label,
      `unread keys at their default (safe to delete): ${hits.map((h) => h.at).join(", ")}`,
    );
  }
  return ok(label, "no unread keys");
}

function auditCheck(ctx: FactoryContext, env: NodeJS.ProcessEnv): DoctorCheck {
  if (isAuditDisabled(env)) {
    return {
      label: "Audit log",
      level: "warn",
      detail: "disabled via GAFFER_AUDIT_OFF",
      fix: "Unset GAFFER_AUDIT_OFF to record an append-only, content-redacted audit of MCP tool calls.",
    };
  }
  const path = resolveAuditPath({ dataDir: ctx.loaded.rootDir, env });
  // SECURITY.md claims doctor verifies the audit log is *writable*. Honour that:
  // probe the real target (the file if it exists, else its parent dir) for write
  // access. A read-only disk / unwritable factory dir means MCP tool calls would
  // silently go unaudited (audit writes are best-effort and never throw), so a
  // human should know before relying on the log for an incident review.
  if (!isAuditWritable(path)) {
    return {
      label: "Audit log",
      level: "warn",
      detail: `not writable: ${path}`,
      fix: "Ensure the audit path (or its parent dir) is writable, or set GAFFER_AUDIT to a writable location. MCP calls go unaudited until then.",
    };
  }

  // File-mode hygiene. The audit log can carry repo/ticket ids and the shape of
  // every MCP call — enough to be worth keeping owner-only. `audit.ts` writes the
  // file 0600 and its parent dir 0700, but a pre-existing log (or one chmod'd by
  // hand / restored from a backup) can be looser. When the file already exists,
  // warn if its mode grants group/other any access (looser than 0600), and the
  // same for the parent dir vs 0700. Mirrors memory-mcp's doctor.
  const looseMode = auditModeConcern(path);
  if (looseMode) {
    return {
      label: "Audit log",
      level: "warn",
      detail: `${looseMode.detail}: ${path}`,
      fix: looseMode.fix,
    };
  }
  return ok("Audit log", path);
}

/**
 * When the audit log file (and/or its dir) already exist, report the first mode
 * that's looser than the owner-only baseline (file 0600, dir 0700). Returns
 * `undefined` when modes are tight, the target doesn't exist yet, or the
 * filesystem has no POSIX modes (mirrors `audit.ts`'s best-effort chmod).
 */
function auditModeConcern(path: string): { detail: string; fix: string } | undefined {
  const fileConcern = modeLooserThan(path, 0o600);
  if (fileConcern !== undefined) {
    return {
      detail: `permissions ${fileConcern} are looser than 0600`,
      fix: `Tighten the audit log to owner-only: chmod 600 ${path}`,
    };
  }
  const dir = dirname(path);
  const dirConcern = modeLooserThan(dir, 0o700);
  if (dirConcern !== undefined) {
    return {
      detail: `directory permissions ${dirConcern} are looser than 0700`,
      fix: `Tighten the audit directory to owner-only: chmod 700 ${dir}`,
    };
  }
  return undefined;
}

/**
 * Returns the octal mode string (e.g. "0644") when `path` exists and grants any
 * permission bit beyond `required`; `undefined` when it's within the baseline,
 * doesn't exist, or can't be stat'd. Bits set beyond `required` (group/other
 * access, or owner-execute on a file) are what "looser" means here.
 */
function modeLooserThan(path: string, required: number): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const mode = statSync(path).mode & 0o777;
    if ((mode & ~required) === 0) return undefined;
    return `0${mode.toString(8).padStart(3, "0")}`;
  } catch {
    return undefined;
  }
}

/**
 * Is the audit log actually writable? Probes the file when it already exists,
 * otherwise its parent directory (which the writer creates lazily). Pure of
 * side effects beyond ensuring the parent dir check is meaningful — never
 * creates the log itself.
 */
function isAuditWritable(path: string): boolean {
  try {
    if (existsSync(path)) {
      accessSync(path, constants.W_OK);
      return true;
    }
    const dir = dirname(path);
    if (existsSync(dir)) {
      accessSync(dir, constants.W_OK);
      return true;
    }
    // Parent dir absent: the writer would mkdir it. Walk up to the nearest
    // existing ancestor and check we could create beneath it.
    let ancestor = dirname(dir);
    while (ancestor && ancestor !== dirname(ancestor) && !existsSync(ancestor)) {
      ancestor = dirname(ancestor);
    }
    if (!existsSync(ancestor)) return false;
    accessSync(ancestor, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function existsDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Render a doctor report as human-readable lines with ✓ / ! / ✗ glyphs. */
export function renderDoctor(report: DoctorReport): string {
  const glyph: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines = ["crew doctor", ""];
  for (const c of report.checks) {
    lines.push(`${glyph[c.level]} ${c.label}`);
    if (c.detail) lines.push(`    ${c.detail}`);
    if (c.fix) lines.push(`    fix: ${c.fix}`);
  }
  lines.push("");
  const hasWarn = report.checks.some((c) => c.level === "warn");
  if (!report.ok) lines.push("Not ready — address the ✗ items above.");
  else if (hasWarn) lines.push("Ready (with warnings).");
  else lines.push("Ready.");
  return lines.join("\n");
}
