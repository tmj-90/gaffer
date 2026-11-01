#!/usr/bin/env node
// Gaffer factory: `gaffer plan`, Plan a build from the terminal.
//
// The dashboard's "Plan a build" panel, without the dashboard. Same planner, same
// confirm step:
//   • a turn is the dashboard's POST /plan-build: dispatch's own plan-build runner
//     (packages/dispatch/dist/api/planBuild.js) spawns runner/bin/decompose.mjs (or
//     GAFFER_DECOMPOSE_BIN) with the same { brief, history, context?, forcePlan? } on
//     stdin. decompose.mjs makes the model call through the worker seam, so the budget
//     admission (a dollar cap is required, daily/lifetime budget), the read-only tool
//     denylist and the usage ledger are the dashboard's, unchanged;
//   • the conversation is the panel's: the brief rides as the first user turn, the
//     planner's questions and your answers follow, and "--now" is "Build the tickets";
//   • creating is the panel's confirm (confirmPlanBuild) and then exactly what POST
//     /epics runs: the plan parsed with the route's schema, Dispatch.createEpic (draft
//     tickets plus the factory's Acceptance ticket), and the brownfield epic → feature
//     hook. Nothing is readied and no autonomy setting changes.
// Nothing is created without --yes or a "y" typed at the prompt. The conversation
// and the last proposal are kept in $GAFFER_DATA/plan-draft.json (0600) between runs,
// so `gaffer plan --yes` creates the plan you were shown, never a fresh one: --yes runs
// on its own (with a goal, --answer or --now it would pay for a turn and create what
// came back unseen), a new answer drops the proposal it supersedes, and the draft names
// the factory it was planned for (its data dir and dispatch database), so a draft copied
// elsewhere or run against another DISPATCH_DB is refused, not created there.
//
// INVOCATION (runner/gaffer plan passes its arguments through):
//   plan-run.mjs "<goal>" | --file <path>  [--repo <name>] [--now]
//   plan-run.mjs --answer "<text>"             answer the planner's questions
//   plan-run.mjs --now                         plan now from what it has
//   plan-run.mjs --yes                         create the proposal on screen (on its own)
//   plan-run.mjs --show | --discard | --list
// EXIT: 0 the epic was created (or --show / --discard / --list) · 4 nothing created
//   yet, waiting for you (the planner asked questions, the proposal is shown and needs
//   --yes, or you said no) · 1 the planner or the create failed, or the draft belongs
//   to another factory (the reason is printed) · 2 a usage error · 75 paused on the
//   usage window (no planner turn was run; `gaffer run` uses the same code).
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAFFER_HOME = resolve(HERE, "..", "..");
const DISPATCH_DIR = process.env.DISPATCH_DIR || join(GAFFER_HOME, "packages", "dispatch");
const dist = (p) => join(DISPATCH_DIR, "dist", p);

const USAGE =
  'usage: gaffer plan "<goal>" | --file <path> [--repo <name>] [--now]  ·  gaffer plan --answer "<text>" | --now  ·  gaffer plan --yes | --show | --discard | --list';
// Nothing created yet: questions asked, a proposal shown, or a "no" at the prompt.
const HELD = 4;
// The factory is paused on the usage window (lib/usage-pause.mjs); `gaffer run`'s code.
const PAUSED = 75;
// A closed stdout (`gaffer plan --show | head`) ends the run quietly, not with a stack.
process.stdout.on("error", (e) => {
  if (e && e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

function out(line = "") {
  process.stdout.write(`${line}\n`);
}
function usageError(msg) {
  process.stderr.write(`  ✗ ${msg}\n${USAGE}\n`);
  process.exit(2);
}
function failWith(msg) {
  process.stderr.write(`  ✗ ${msg}\n`);
  process.exit(1);
}

// ── arguments ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { goal: "", file: "", repo: "", answers: [], now: false, yes: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v === "") usageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") o.file = value(i++, a);
    else if (a.startsWith("--file=")) o.file = a.slice(7);
    else if (a === "--repo") o.repo = value(i++, a);
    else if (a.startsWith("--repo=")) o.repo = a.slice(7);
    else if (a === "--answer") o.answers.push(value(i++, a));
    else if (a.startsWith("--answer=")) o.answers.push(a.slice(9));
    else if (a === "--now") o.now = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--show") o.show = true;
    else if (a === "--discard") o.discard = true;
    else if (a === "--list") o.list = true;
    else if (a.startsWith("-")) usageError(`unknown option '${a}'`);
    else if (o.goal) usageError(`one goal only (quote it): got '${o.goal}' and '${a}'`);
    else o.goal = a;
  }
  // HUMAN IN THE LOOP: --yes creates the proposal already on screen, so it never rides
  // with a turn (a goal, --answer, --now): that would pay for a plan and create it unseen.
  if (o.yes && (o.goal || o.file || o.repo || o.answers.length || o.now))
    usageError(
      "--yes runs on its own: it creates the proposal you were already shown. Plan first " +
        '(gaffer plan "<goal>", --answer, --now), read the proposal, then run gaffer plan --yes',
    );
  const modes = [o.show, o.discard, o.list].filter(Boolean).length;
  if (modes > 1) usageError("--show, --discard and --list each run on their own");
  if (modes === 1 && (o.goal || o.file || o.repo || o.answers.length || o.now || o.yes))
    usageError("--show, --discard and --list take no other argument");
  if (o.goal && o.file) usageError("give the goal as text or --file, not both");
  if ((o.goal || o.file) && o.answers.length)
    usageError("--answer continues the saved plan; start a new one without it");
  if (o.repo && !(o.goal || o.file))
    usageError("--repo sets the target of a NEW plan: give the goal too");
  if (o.file) {
    try {
      o.goal = readFileSync(o.file, "utf8");
    } catch (e) {
      usageError(`cannot read ${o.file}: ${e.code || e.message}`);
    }
  }
  o.goal = o.goal.trim();
  if (o.file && !o.goal) usageError(`${o.file} is empty`);
  // The dashboard caps the brief at 4000 characters (planBuildBody); so does this.
  if (o.goal.length > 4000) usageError(`the goal is ${o.goal.length} characters (at most 4000)`);
  return o;
}

// ── the saved conversation ──────────────────────────────────────────────────
const DATA = process.env.GAFFER_DATA || "";
const DRAFT = DATA ? join(DATA, "plan-draft.json") : "";

// The factory a draft was planned for: its data dir and dispatch database, resolved.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
function thisFactory() {
  return { gaffer_data: real(DATA), dispatch_db: real(process.env.DISPATCH_DB || "") };
}
/** Why `d` may not be continued or created HERE (null when it may). */
function foreignDraft(d) {
  const here = thisFactory();
  const f = d && d.factory;
  if (f && f.gaffer_data === here.gaffer_data && f.dispatch_db === here.dispatch_db) return null;
  const was = f
    ? `data ${f.gaffer_data || "?"}, dispatch db ${f.dispatch_db || "?"}`
    : "a factory it does not name";
  return (
    `this draft plan belongs to another factory (${was}); this one is data ${here.gaffer_data}, ` +
    `dispatch db ${here.dispatch_db}. Nothing was created or asked. Plan it here: ` +
    'gaffer plan "<goal>" (gaffer plan --discard drops the draft)'
  );
}

function loadDraft() {
  if (!DRAFT || !existsSync(DRAFT)) return null;
  try {
    const d = JSON.parse(readFileSync(DRAFT, "utf8"));
    return d && typeof d === "object" && typeof d.brief === "string" ? d : null;
  } catch {
    return null;
  }
}
function saveDraft(d) {
  if (!DRAFT) return;
  writeFileSync(DRAFT, JSON.stringify({ ...d, updated_at: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  chmodSync(DRAFT, 0o600);
}
function dropDraft() {
  if (DRAFT) rmSync(DRAFT, { force: true });
}

// ── the dashboard's pieces, from dispatch's own build ───────────────────────
async function load(p) {
  const file = dist(p);
  if (!existsSync(file)) failWith(`${file} is missing: build the packages first (pnpm -r build)`);
  return import(file);
}

/** One planner turn: the dashboard's POST /plan-build body, through its runner. */
async function planTurn(draft, forcePlan) {
  const { createPlanBuildRunner } = await load("api/planBuild.js");
  // submitPlanBuildTurn: never resend a failed turn; the brief rides as a user answer.
  const history = draft.history
    .filter((t) => !(t.role === "assistant" && t.error))
    .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t));
  return createPlanBuildRunner(process.env).run({
    brief: draft.brief,
    history,
    ...(draft.context ? { context: draft.context } : {}),
    ...(forcePlan ? { forcePlan: true } : {}),
  });
}

/** The answers given to the planner's questions (the brief is not one): planClarifications. */
async function agreedRequirements(draft) {
  const { agreedRequirementsFromTurns } = await load("util/planClarifications.js");
  // An assistant turn is a clarify turn only when it asked questions; a failed turn
  // (error) is not, so the answer after it answers nothing (the panel's
  // planAgreedRequirements resets on it the same way).
  const turns = draft.history.map((h) =>
    h.role === "assistant"
      ? {
          role: "assistant",
          content: JSON.stringify(
            Array.isArray(h.questions)
              ? { phase: "clarify", questions: h.questions }
              : { phase: "error" },
          ),
        }
      : { role: "user", content: String(h.brief ?? h.answer ?? "") },
  );
  return agreedRequirementsFromTurns(turns);
}

function openDispatch(shared) {
  const db = process.env.DISPATCH_DB;
  if (!db) failWith("DISPATCH_DB is not set (run this through runner/gaffer plan)");
  return shared.open({ db });
}

// ── showing a proposal ──────────────────────────────────────────────────────
const acText = (ac) => (typeof ac === "string" ? ac : (ac && ac.text) || "");

async function showPlan(draft, { creating = false } = {}) {
  const { criterionCovers } = await load("util/planClarifications.js");
  const plan = draft.plan;
  const tickets = plan.tickets || [];
  out(`Proposed epic: ${plan.epic.name}`);
  if (plan.epic.description) out(`  ${plan.epic.description.split("\n").join("\n  ")}`);
  out(`  brief: ${draft.brief.split("\n").join(" ")}`);
  if (draft.context && draft.context.repo) out(`  extends: ${draft.context.repo}`);
  out("");
  tickets.forEach((t, i) => {
    const tags = [
      t.bootstrap ? "bootstrap" : null,
      t.repo ? `repo ${t.repo}` : null,
      t.risk_level ? `risk ${t.risk_level}` : null,
      Number.isFinite(t.priority) && t.priority ? `priority ${t.priority}` : null,
      (t.dependsOn || []).length ? `after ${t.dependsOn.map((d) => `T${d + 1}`).join(", ")}` : null,
    ].filter(Boolean);
    out(`T${i + 1}  ${t.title}${tags.length ? `   (${tags.join(" · ")})` : ""}`);
    if (t.description) out(`    ${String(t.description).split("\n").join("\n    ")}`);
    for (const ac of t.acceptanceCriteria || []) out(`    - ${acText(ac)}`);
  });
  out(
    `Final  Acceptance: ${plan.epic.name}   (the factory adds it: after every ticket above; the independent tester checks the brief end to end)`,
  );
  const agreed = await agreedRequirements(draft);
  if (agreed.length) {
    const criteria = tickets.flatMap((t) => (t.acceptanceCriteria || []).map(acText));
    out("");
    out("Agreed while planning (each becomes a criterion of the Final):");
    for (const r of agreed) {
      const covered = criteria.some((c) => criterionCovers(c, r.answer));
      out(`  - ${r.answer}${covered ? "" : "   ! no proposed criterion covers this"}`);
    }
  }
  out("");
  out(
    creating
      ? `--yes: creating these ${tickets.length} ticket(s) plus the Final as draft; none is readied.`
      : `Nothing is created yet. ${tickets.length} ticket(s) plus the Final would land as draft; none is readied.`,
  );
}

function showQuestions(questions) {
  out("The planner asks:");
  questions.forEach((q, i) => out(`  ${i + 1}. ${q}`));
}

// ── creating: the dashboard's confirm, then the POST /epics route's steps ────
async function createFromDraft(draft) {
  const shared = await load("cli/shared.js");
  const { createEpicBody } = await load("api/schemas.js");
  const { brownfieldEpicRepo, createEpicFeatureRunner } = await load("api/epicFeature.js");
  const wg = openDispatch(shared);
  try {
    // confirmPlanBuild: a repo that is not registered yet (greenfield) drops repo/access
    // and carries the name on `source`; the bootstrap registers it later.
    const known = new Set(wg.listRepositories(false).map((r) => r.name));
    let deferred = 0;
    const tickets = (draft.plan.tickets || []).map((t) => {
      if (t.repo && !known.has(t.repo)) {
        deferred += 1;
        const { repo, access: _access, ...rest } = t;
        return rest.source ? rest : { ...rest, source: repo };
      }
      return t;
    });
    const agreed = await agreedRequirements(draft);
    const epic = {
      ...draft.plan.epic,
      brief: String(draft.brief).slice(0, 20000),
      agreed_requirements: agreed,
    };
    // routeEpics: the body through the route's schema, createEpic, the brownfield hook.
    const body = createEpicBody.parse({ epic, tickets });
    const result = wg.createEpic(body, shared.cliActor());
    const featureRepo = brownfieldEpicRepo(wg, body, result);
    if (featureRepo !== null) {
      createEpicFeatureRunner(process.env, wg).trigger({
        repo: featureRepo,
        epic: result.epicNodeId,
        name: body.epic.name,
        summary: (body.epic.description ?? "").trim().slice(0, 300),
      });
    }
    return { result, deferred };
  } finally {
    wg.db.close();
  }
}

function describeError(e) {
  if (e && Array.isArray(e.issues)) {
    return `the plan does not fit an epic: ${e.issues
      .slice(0, 5)
      .map((i) => `${(i.path || []).join(".") || "plan"}: ${i.message}`)
      .join("; ")}`;
  }
  return e && e.code && e.message ? `${e.code}: ${e.message}` : String((e && e.message) || e);
}

async function create(draft) {
  let made;
  try {
    made = await createFromDraft(draft);
  } catch (e) {
    failWith(`could not create the epic, nothing was created: ${describeError(e)}`);
  }
  const { result, deferred } = made;
  dropDraft();
  const nums = result.ticketNumbers || [];
  out(
    `  ✓ created epic ${result.epicNodeId}: ${nums.length} draft ticket(s) ${nums.map((n) => `#${n}`).join(" ")}` +
      (result.acceptanceTicketNumber ? ` (the Final is #${result.acceptanceTicketNumber})` : ""),
  );
  if (deferred)
    out(`    ${deferred} repo link(s) deferred to the bootstrap, which registers the new repo`);
  if (result.agreedRequirements)
    out(`    ${result.agreedRequirements} agreed requirement(s) are criteria of the Final`);
  out(
    `  next: look them over (gaffer wg ticket show <n>, or the board), then ready each one: gaffer wg ticket ready <n>`,
  );
}

// ── the interactive bits (a person at a terminal only) ──────────────────────
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let rl = null;
/** The typed line, or null on EOF (Ctrl-D): the caller treats that as "stop, keep it". */
function ask(q) {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-C at a prompt stops here (readline would otherwise only pause and hang).
    rl.on("SIGINT", () => {
      out("");
      out("Stopped. Nothing was created; the draft is kept.");
      process.exit(130);
    });
  }
  const r = rl;
  return new Promise((res) => {
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      rl = null;
      out("");
      res(null);
    };
    r.once("close", onClose);
    r.question(q, (a) => {
      if (settled) return;
      settled = true;
      r.off("close", onClose);
      res(a);
    });
  });
}
function closeAsk() {
  if (rl) rl.close();
  rl = null;
}

// ── one round: ask the planner, record its answer, show it ──────────────────
// USAGE WINDOW: while the factory is paused on it (lib/usage-pause.mjs, what tick and
// `gaffer run` honour), a planner turn is not started; it would only be refused. Checked
// before a turn changes the draft, and again before each turn of an interactive run.
async function refuseWhilePaused() {
  const { readPause, pauseLine } = await import(join(HERE, "..", "lib", "usage-pause.mjs"));
  const pause = readPause(process.env);
  if (!pause) return;
  process.stderr.write(
    `  ✗ the factory is paused on the usage window (${pauseLine(pause)}); no planner turn was run ` +
      "and the draft is unchanged. It lifts on its own; node runner/lib/usage-pause.mjs clear lifts it now.\n",
  );
  process.exit(PAUSED);
}

async function round(draft, forcePlan) {
  await refuseWhilePaused();
  out(forcePlan ? "Planning with what it has…" : "Asking the planner…");
  const res = await planTurn(draft, forcePlan);
  if (res.phase === "clarify") {
    draft.history.push({ role: "assistant", questions: res.questions || [] });
    draft.plan = null;
    saveDraft(draft);
    return "clarify";
  }
  if (res.phase === "plan" && res.plan && Array.isArray(res.plan.tickets)) {
    draft.plan = res.plan;
    saveDraft(draft);
    return "plan";
  }
  const why = res.error || "the planner returned no plan";
  draft.history.push({ role: "assistant", error: why });
  saveDraft(draft);
  failWith(`the planner failed: ${why}`);
}

async function converse(draft, forcePlan) {
  let state = await round(draft, forcePlan);
  for (;;) {
    if (state === "clarify") {
      showQuestions(draft.history[draft.history.length - 1].questions);
      if (!interactive) {
        out("");
        out(
          'Answer them: gaffer plan --answer "<your answer>"   or plan with what it has: gaffer plan --now',
        );
        process.exitCode = HELD;
        return;
      }
      const typed = await ask(
        "Your answer (Enter alone plans with what it has, q stops and keeps the draft): ",
      );
      const a = typed === null ? "q" : typed.trim();
      if (a === "q") {
        out('Kept the draft: gaffer plan --answer "…" or --now carries on.');
        process.exitCode = HELD;
        return;
      }
      if (a) draft.history.push({ role: "user", answer: a });
      state = await round(draft, !a);
      continue;
    }
    await showPlan(draft);
    if (!interactive) {
      out(
        'Create it as shown: gaffer plan --yes   (or answer more: gaffer plan --answer "…"; start over: gaffer plan --discard)',
      );
      process.exitCode = HELD;
      return;
    }
    const yn = ((await ask(`Create these as draft tickets? [y/N] `)) ?? "").trim().toLowerCase();
    if (yn === "y" || yn === "yes") return create(draft);
    out(
      "Not created. The proposal is kept: gaffer plan --yes creates it, gaffer plan --discard drops it.",
    );
    process.exitCode = HELD;
    return;
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!DATA) failWith("GAFFER_DATA is not set (run this through runner/gaffer plan)");

  if (o.list) {
    const shared = await load("cli/shared.js");
    const wg = openDispatch(shared);
    try {
      const epics = wg.listScopeNodes().filter((n) => n.type === "epic");
      if (!epics.length) out('No epics yet. Plan one: gaffer plan "<goal>"');
      for (const e of epics) out(`${e.id}  ${e.name}`);
    } finally {
      wg.db.close();
    }
    return;
  }
  const saved = loadDraft();
  if (o.discard) {
    out(
      saved
        ? `Dropped the draft plan for: ${saved.brief.split("\n")[0]}`
        : "No draft plan to drop.",
    );
    dropDraft();
    return;
  }
  if (o.show) {
    if (!saved) return out('No draft plan. Start one: gaffer plan "<goal>"');
    const foreign = foreignDraft(saved);
    if (foreign) out(`(${foreign})`);
    const last = saved.history[saved.history.length - 1];
    if (saved.plan) await showPlan(saved);
    else if (last && last.role === "assistant" && Array.isArray(last.questions)) {
      out(`Draft plan for: ${saved.brief}`);
      showQuestions(last.questions);
    } else out(`Draft plan for: ${saved.brief} (no proposal yet: gaffer plan --now)`);
    return;
  }

  if (o.goal || o.answers.length || o.now) await refuseWhilePaused();
  // A new plan: the brief is the first user turn (the dashboard's first message).
  if (o.goal) {
    // Extend an existing repo: it must be registered (the panel only offers registered
    // ones), checked before the planner is paid for a turn.
    if (o.repo) {
      const shared = await load("cli/shared.js");
      const wg = openDispatch(shared);
      let hit;
      try {
        hit = wg.listRepositories(true).find((r) => r.name === o.repo || r.id === o.repo);
      } finally {
        wg.db.close();
      }
      if (!hit)
        usageError(`no registered repo '${o.repo}' (gaffer wg repo list; onboard it first)`);
      o.repo = hit.name;
    }
    if (saved) out(`(replacing the earlier draft plan for: ${saved.brief.split("\n")[0]})`);
    const draft = {
      version: 2,
      factory: thisFactory(),
      brief: o.goal,
      ...(o.repo ? { context: { mode: "extend", repo: o.repo } } : {}),
      history: [{ role: "user", brief: o.goal }],
      plan: null,
    };
    saveDraft(draft);
    return converse(draft, o.now);
  }
  // Carry on with the saved conversation, in the factory it was planned for only.
  if (!saved) usageError('no draft plan to continue: start one with gaffer plan "<goal>"');
  const foreign = foreignDraft(saved);
  if (foreign && (o.answers.length || o.now || o.yes)) failWith(foreign);
  if (o.answers.length) {
    for (const a of o.answers) saved.history.push({ role: "user", answer: a.trim() });
    // An answer supersedes the proposal on screen: --yes must not create that one now,
    // even when the turn that answer starts fails.
    saved.plan = null;
    saveDraft(saved);
    return converse(saved, false);
  }
  if (o.now) return converse(saved, true);
  if (o.yes) {
    if (!saved.plan)
      usageError(
        "the draft has no proposal yet: answer the questions (--answer) or plan now (--now)",
      );
    await showPlan(saved, { creating: true });
    return create(saved);
  }
  usageError(
    'say what to plan: gaffer plan "<goal>" (or --answer, --now, --yes, --show, --discard, --list)',
  );
}

main()
  .then(() => {
    closeAsk();
  })
  .catch((e) => {
    closeAsk();
    failWith(describeError(e));
  });
