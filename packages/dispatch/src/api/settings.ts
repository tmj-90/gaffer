import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { notifyAllowsPrivate, notifyUrlProblem } from "../notify/urlPolicy.js";
import { DispatchError } from "../util/errors.js";

/**
 * UI-editable factory settings — the dispatch side of an env-override config
 * layer.
 *
 * The factory's runtime config is all environment variables (sourced from
 * `factory.config.sh` in the runner). This module adds a small, UI-editable
 * persistence file the runner reads with **env-override** semantics: an explicit
 * environment variable ALWAYS wins over the file. Concretely the runner sources
 * the file and then applies `: "${KEY:=<file-value>}"` so a key already set in
 * the environment is left untouched.
 *
 * The contract this module owns:
 *
 *   - Storage: `$GAFFER_DATA/settings.json` — a FLAT JSON object mapping a known
 *     setting key to its STRING value, e.g. `{ "MAX_TICKS": "50" }`. Values are
 *     always strings (env vars are strings); the UI coerces booleans/ints to the
 *     string form the runner expects ("0"/"1" for booleans).
 *   - env-locked: a key is read-only in the UI when `process.env[KEY]` is set,
 *     because an explicit env var overrides the file, so editing the file for
 *     that key would have no effect. The API reports such keys `envLocked` and
 *     {@link writeSettings} refuses to persist them.
 *
 * The file is the source of truth for UI edits; the runner is the consumer.
 * Changes take effect on the NEXT factory tick — there is no live restart, and
 * none is needed: every tick re-sources the config, and a running loop or
 * `gaffer run --daemon` re-derives what its parent exported (factory.config.sh
 * "RE-SOURCE HYGIENE"), so only the operator's real env still overrides the file.
 * The day caps (MAX_TICKS_PER_DAY, GAFFER_DAILY_BUDGET_USD) are re-read by loop.sh
 * and every pool worker before each admission (lib/budget.sh
 * gaffer_refresh_day_caps). The run-shape knobs a loop reads once when it starts —
 * MAX_TICKS, GAFFER_CONCURRENCY, TICK_SLEEP, EMPTY_POLL_LIMIT — apply from the next
 * loop pass (the next daemon pass, or the next run).
 */

/** A logical grouping for the settings panel's sections. */
export type SettingGroup =
  | "autonomy"
  | "delivery"
  | "execution"
  | "idle-loops"
  | "budget"
  | "planning-debate"
  | "quality"
  | "sandbox"
  | "notifications";

/** The value type a setting carries, so the UI renders the right control. */
export type SettingType = "boolean" | "int" | "csv" | "string";

/** Static descriptor for one known setting. */
export interface SettingDef {
  readonly key: string;
  readonly type: SettingType;
  readonly group: SettingGroup;
  readonly label: string;
  readonly help?: string;
  /**
   * Closed set of allowed values for an enum-style `string` setting (e.g.
   * GAFFER_MODE). When present the UI renders a dropdown instead of a free-text
   * box, and {@link writeSettings} refuses any value outside the list (empty is
   * always allowed — it clears the override back to the built-in default).
   */
  readonly choices?: readonly string[];
}

/** One setting as reported to the UI by GET /api/settings. */
export interface SettingView {
  readonly key: string;
  /** Current file value, or "" when unset in settings.json. */
  readonly value: string;
  /**
   * The value the factory will actually use: the operator's env when locked, else
   * the stored file value, else the GAFFER_MODE preset, else "" (built-in default).
   */
  readonly effective: string;
  /** Where `effective` came from. */
  readonly source: SettingSource;
  /** True iff the OPERATOR set this key in the real environment — read-only in the UI. */
  readonly envLocked: boolean;
  readonly type: SettingType;
  readonly group: SettingGroup;
  readonly label: string;
  readonly help?: string;
  /** Allowed values for an enum setting — the UI renders these as a dropdown. */
  readonly choices?: readonly string[];
}

/**
 * The known settings, grouped. This is the allow-list: GET reports exactly these
 * keys and POST silently drops anything not in here, so the UI can never write an
 * arbitrary env var into the file.
 */
export const SETTING_DEFS: readonly SettingDef[] = [
  // --- Autonomy: how much the factory may do without a human in the loop ---
  {
    key: "GAFFER_MODE",
    type: "string",
    choices: ["supervised", "lite", "graduated", "autonomous", "strict"],
    group: "autonomy",
    label: "Autonomy mode",
    help:
      "Preset that sets the whole autonomy cluster at once (review mode, agent " +
      "approval, auto-merge, auto-push, memory auto-approve): supervised · lite · " +
      "graduated · autonomous · strict. supervised (default) keeps a human on every " +
      "merge; lite auto-approves only GENUINELY TRIVIAL tickets (low risk, tiny diff, " +
      "no sensitive path) that passed every gate + earned an APPROVE from the reviewer " +
      "agent — and still leaves a human to MERGE (never auto-merges); non-trivial " +
      "tickets hold for you. (Because auto-approve drops the human quality gate, lite " +
      "requires the OS sandbox — GAFFER_STRICT_REQUIRE defaults on.) " +
      "graduated ships what each repo has EARNED at its risk level and holds " +
      "everything else for you (the reviewer agent runs, but the per-repo/risk autonomy " +
      "policy is the sole allow-path — set grants in the per-repo policy editor); " +
      "autonomous lets agents approve and auto-merges + pushes approved work; " +
      "strict adds OS-level sandbox containment on top of autonomous, chosen by " +
      "SANDBOX_PROVIDER: docker (any host with Docker) gives real read + egress " +
      "isolation; sandbox-exec (macOS) is a write-only sandbox, so with sandbox-exec on " +
      "a non-macOS host strict has no OS containment beyond the deterministic hook — set " +
      "GAFFER_STRICT_REQUIRE=1 to fail closed rather than degrade. " +
      "Picking a mode prevents a " +
      "half-configured autonomy posture. The individual knobs below still " +
      "override the mode — an explicitly-set flag always wins.",
  },
  {
    key: "DISPATCH_ALLOW_AGENT_APPROVE",
    type: "boolean",
    group: "autonomy",
    label: "Agents may approve reviews",
    help:
      "Let an agent actor approve a ticket's review (otherwise human-only). An agent " +
      "approve is still held for a person whenever the real diff's observed risk exceeds " +
      "the declared risk, and ALWAYS when the delivery changed the tests that gate it " +
      "(deleted or renamed a test file, added a skip/only marker, changed a gate script, " +
      "one of its pre/post hooks or a script it runs, touched test config, or added or changed a " +
      "package-manager rc file such as .npmrc) — unless a " +
      "person allowed test changes on that ticket (`wg ticket allow-test-changes <n>`, or " +
      "Allow test changes on the Review page). The allowance clears the hold only; the " +
      "gate still runs the base commit's scripts.",
  },
  {
    key: "MERGE_ON_AGENT_REVIEW",
    type: "boolean",
    group: "autonomy",
    label: "Auto-merge on agent review",
    help:
      "Extend Auto-merge on approval to approvals the runner makes on an agent reviewer's " +
      "verdict. Needs Auto-merge on approval ON as well: on its own this merges nothing " +
      "(agent-approved tickets wait at ready-for-merge and the run logs a warning). With " +
      "both on, an agent-approved ticket lands with no human in the loop — an OS sandbox is " +
      "then required (GAFFER_STRICT_REQUIRE).",
  },
  {
    key: "MEMORY_AUTO_APPROVE",
    type: "boolean",
    group: "autonomy",
    label: "Auto-approve runner memory drafts",
    help:
      "Let the memory the runner itself files go live without a human review step: the " +
      "requirement distilled from each delivered ticket, onboarding's induction lore and " +
      "`memory suggest` from the CLI. Lore a delivery agent suggests over MCP always " +
      "stays a draft for you to approve, whatever this says.",
  },
  {
    key: "GAFFER_TESTING",
    type: "boolean",
    group: "autonomy",
    label: "Independent black-box testing",
    help:
      "When on, an approved testable ticket routes through the independent testing " +
      "lane (in_review → in_testing) instead of straight to merge. The lane, the " +
      "contract, and the runner seam are live; the seam hands an independent tester " +
      "the contract + AC (never the diff). Only tickets carrying the testable flag are " +
      "routed (`wg ticket set-testable <n>`; the planner does not set it) — the rest go " +
      "straight from approval to merge, as does everything when this is off.",
  },

  // --- Idle loops: the between-work background loops + their mode ---
  {
    key: "GAFFER_IDLE_FEATURE_BACKLOG",
    type: "boolean",
    group: "idle-loops",
    label: "Feature-backlog idle loop",
    help:
      "When idle, pull one `backlog` feature from the factory's memory ledger and plan it " +
      "as an epic. Each idle tick (before the maintenance lane) claims one `backlog` " +
      "feature, moves it to `building`, makes ONE paid plan call (the runner's own " +
      "bin/decompose.mjs, run unattended with --force-plan so it plans without asking " +
      "questions; counted against the day cap) and files the epic as drafts (or ready " +
      "tickets if the idle-loop mode says so). A failed plan releases the feature back to " +
      "`backlog`, and after `loops.idle_feature_backlog.max_plan_failures` (default 2) " +
      "failed plans in a row idle ticks stop claiming it; plan it from the dashboard. " +
      "Overrides the crew.yaml `loops.idle_feature_backlog.enabled` flag (the same toggle " +
      "as the Feature backlog row in the Idle loops panel) for every crew run the runner " +
      "spawns; empty = crew.yaml decides.",
  },
  {
    key: "GAFFER_MAINTENANCE",
    type: "string",
    choices: ["0", "1"],
    group: "idle-loops",
    label: "Maintenance lane override",
    help:
      "Overrides the Idle loops panel's master switch (crew.yaml `loops.maintenance.enabled`): " +
      "0 = kill switch, an idle tick never runs maintenance · 1 = run the lane even while " +
      "the switch is off · empty = the panel decides. It only turns the LANE on: it rotates " +
      "through the lanes you enabled, so with none enabled an idle tick still does nothing " +
      "(and reports no_work).",
  },
  {
    key: "GAFFER_IDLE_MODE",
    type: "string",
    choices: ["observe_only", "create_draft_tickets", "create_ready_tickets"],
    group: "idle-loops",
    label: "Idle-loop mode",
    help:
      "How far EVERY idle loop goes with a finding: observe_only reports it and files " +
      "nothing · create_draft_tickets files a draft for a human to ready (the default) · " +
      "create_ready_tickets files it past the human gate. When set it overrides each " +
      "loop's `mode` in crew.yaml for the crew runs the runner spawns; empty = crew.yaml " +
      "decides per loop.",
  },

  // --- Budget / caps: hard limits on a run ---
  {
    key: "MAX_TICKS",
    type: "int",
    group: "budget",
    label: "Max ticks (run)",
    help: "Upper bound on factory ticks for a single run. A change applies from the next loop pass.",
  },
  {
    key: "MAX_TICKS_PER_DAY",
    type: "int",
    group: "budget",
    label: "Max ticks / day",
    help:
      "Daily ceiling on factory ticks that did (or may have done) paid work — a " +
      "no-work poll does not count. A running loop re-reads it before every tick. " +
      "0 = unlimited.",
  },
  {
    key: "GAFFER_DAILY_BUDGET_USD",
    type: "string",
    group: "budget",
    label: "Daily budget (USD)",
    help:
      "Per-UTC-day spend ceiling, summed from the usage ledger (measured cost plus the " +
      "labelled estimate booked for a killed/timed-out call). Once today's spend is at " +
      "or over it, no new paid work starts until the next UTC day — the loop, every " +
      "parallel worker, the daemon and the dashboard's Poll button all honour it. " +
      "Empty or 0 = off.",
  },
  {
    key: "GAFFER_TICK_TIMEOUT",
    type: "int",
    group: "budget",
    label: "Tick timeout (s)",
    help: "Wall-clock cap on a single tick before it is killed.",
  },
  {
    key: "GAFFER_MAX_TURNS",
    type: "int",
    group: "budget",
    label: "Max turns / agent",
    help:
      "Turn cap for one delivery agent call, and the ceiling for every other role " +
      "(reviewer, clarify, planner, tester, …): each runs under the lower of its own " +
      "cap and this one, so raising it never lifts a role above its own cap.",
  },
  // --- Cost-as-control (Track 3a): spend steers routing, not just reporting ---
  {
    key: "GAFFER_BUDGET_USD",
    type: "string",
    group: "budget",
    label: "Budget ceiling (USD)",
    help:
      "Total factory spend ceiling in USD (summed from the usage-ledger). As " +
      "headroom runs low the router biases cheaper; at $0 headroom no new paid work " +
      "starts (ticks, Poll and the daemon refuse) and in-flight work pauses. " +
      "Empty = unlimited.",
  },
  {
    key: "GAFFER_BUDGET_LOW_THRESHOLD",
    type: "string",
    group: "budget",
    label: "Budget-low threshold (USD)",
    help:
      "USD headroom at/under which routing biases one tier CHEAPER. Empty auto-derives " +
      "~20% of the budget ceiling; set explicitly to override.",
  },
  {
    key: "GAFFER_CHEAP_PHASES",
    type: "csv",
    group: "budget",
    label: "Cheap-tier phases",
    help:
      "Comma-separated phases whose work is biased to the cheap model tier. " +
      "Only 'implement' is routed through the model router today, so 'implement' is " +
      "the only value with any effect; other phase names are inert until their call " +
      "sites are routed. High/critical-risk work is never cheapened.",
  },

  // --- Planning debate: multi-model plan critique ---
  {
    key: "GAFFER_PLAN_DEBATE",
    type: "boolean",
    group: "planning-debate",
    label: "Plan debate",
    help: "Run a multi-model debate over the plan before decomposing.",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MODELS",
    type: "csv",
    group: "planning-debate",
    label: "Debate models",
    help: "Comma-separated model ids that take part in the debate.",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MAX_ROUNDS",
    type: "int",
    group: "planning-debate",
    label: "Debate max rounds",
    help: "Upper bound on debate rounds.",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MIN_ESTIMATE",
    type: "int",
    group: "planning-debate",
    label: "Debate min estimate",
    help: "Only debate plans whose estimate is at least this.",
  },

  // --- Notifications (H2): opt-in pings when the factory needs a human ---
  // The factory runs unattended; these surface the human-gate transitions
  // (review needed · ticket blocked/parked · decision pending) outside the
  // dashboard. All default off → a no-op notifier with zero overhead. The
  // dispatch facade reads these via src/notify/config.ts (NOTIFY_ENV).
  {
    key: "GAFFER_NOTIFY_WEBHOOK_URL",
    type: "string",
    group: "notifications",
    label: "Webhook URL",
    help: "POST each human-gate event as JSON to this URL (the generic integration).",
  },
  {
    key: "GAFFER_NOTIFY_SLACK_URL",
    type: "string",
    group: "notifications",
    label: "Slack webhook URL",
    help: "Slack incoming-webhook URL — gates arrive as a Slack message.",
  },
  {
    key: "GAFFER_NOTIFY_DESKTOP",
    type: "boolean",
    group: "notifications",
    label: "Desktop notifications",
    help:
      "Fire a native desktop banner on each human gate (macOS: terminal-notifier or " +
      "osascript; Linux: notify-send, which must be installed). Check it with " +
      "`gaffer wg notify test` — it reports each sink and fails when one did not deliver.",
  },
  {
    key: "GAFFER_NOTIFY_EVENTS",
    type: "csv",
    group: "notifications",
    label: "Notify on events",
    help:
      "Comma-separated allow-list of gate kinds to notify on " +
      "(review_needed · ticket_blocked · ticket_parked · decision_pending). " +
      "Empty = all gates.",
  },
  {
    key: "GAFFER_NOTIFY_FULL_PAYLOAD",
    type: "boolean",
    group: "notifications",
    label: "Send full webhook payload",
    help:
      "Outbound notifications are REDACTED by default (kind · ticket number · status · " +
      "dashboard URL). The free-text ticket title/detail can be prompt-injection-" +
      "influenced, so they never leave the box unless you opt in here. Enable ONLY when " +
      "the webhook/Slack endpoint is inside your trust boundary.",
  },

  // --- Autonomy (cont.): who reviews a delivery ---
  {
    key: "REVIEW_MODE",
    type: "string",
    choices: ["human", "agent", "both"],
    group: "autonomy",
    label: "Review mode",
    help:
      "Who reviews a delivery before merge: human · agent · both. Under agent the runner " +
      "may act on the reviewer's verdict where the autonomy floor or an earned per-repo " +
      "grant allows (approve, merge, or send CHANGES back to rework); otherwise the review " +
      "is advisory and a human approves. Under both the agent screens first — a CHANGES " +
      "verdict can still bounce the delivery to rework — but its APPROVE never approves: " +
      "the ticket waits in review for a human to confirm, in every autonomy mode. Per-repo " +
      "autonomy grants act only under agent or both; under human no reviewer agent runs, " +
      "so they are inert.",
  },

  // --- Delivery: what the factory does once a ticket is approved ---
  {
    key: "AUTO_MERGE",
    type: "boolean",
    group: "delivery",
    label: "Auto-merge on approval",
    help:
      "Safe-merge a HUMAN-approved ticket into the default branch on approval (the dashboard " +
      "Approve fires the merge runner; the runner's merge lane lands human approvals made by " +
      "any route). Off → approved tickets wait at ready-for-merge until a human presses Merge. " +
      "An agent approval never lands on this alone: it also needs Auto-merge on agent review " +
      "(or an earned per-repo merge grant). A conflict spawns the resolver agent, re-gates its " +
      "resolution (conflict markers + the DoD gates) and reopens the ticket for re-review.",
  },
  {
    key: "GAFFER_AUTO_PUSH",
    type: "boolean",
    group: "delivery",
    label: "Push after merge",
    help: "The final AFK step: push the default branch to origin after a successful auto-merge. Requires Auto-merge; off → merges stay local.",
  },
  {
    key: "GAFFER_CREATE_PR",
    type: "boolean",
    group: "delivery",
    label: "Deliver as a pull request",
    help:
      "Push the delivery branch and open a GitHub PR carrying the evidence. Approval then " +
      "merges THROUGH that PR (gh pr merge, method below) and fast-forwards the local default " +
      "branch — never a local merge that leaves the PR open. Needs the gh CLI authenticated; " +
      "if gh fails the merge falls back to local and says so.",
  },
  {
    key: "GAFFER_PR_MERGE_METHOD",
    type: "string",
    choices: ["merge", "squash", "rebase"],
    group: "delivery",
    label: "PR merge method",
    help: "How an approved PR is landed by gh pr merge: merge (default) · squash · rebase. Only used with 'Deliver as a pull request'.",
  },
  {
    key: "GAFFER_REQUIRE_CI",
    type: "boolean",
    group: "delivery",
    label: "Require CI green before review",
    help:
      "Poll the delivery PR's CI checks and only let the ticket into review when they pass; " +
      "red checks reject it back to rework. REQUIRES 'Deliver as a pull request' — the checks " +
      "live on the PR, so with PR delivery off this gate is skipped with a warning (it used to " +
      "poll a PR that never existed and reject every delivery at the timeout).",
  },
  {
    key: "GAFFER_ALLOW_SELF_DELIVERY",
    type: "boolean",
    group: "delivery",
    label: "Allow self-delivery",
    help:
      "Permit the factory to deliver into its OWN repo. Off (default) is the safe choice — it never edits itself by accident: " +
      "a ticket where any of its write repos (not only the first) is the gaffer checkout root (or any directory above it), a component dir inside it, " +
      "or a worktree of the same git repo is set aside for a human instead of delivered.",
  },

  // --- Execution: how the loop schedules and paces work ---
  {
    key: "GAFFER_CONCURRENCY",
    type: "int",
    group: "execution",
    label: "Concurrent ticks",
    help:
      "How many tickets run in parallel, each in its own git worktree. 1 = strictly serial (safest); >1 fans out. " +
      "A change applies from the next loop pass.",
  },
  {
    key: "TICK_SLEEP",
    type: "int",
    group: "execution",
    label: "Pause between ticks (s)",
    help: "Seconds the loop waits between ticks. A change applies from the next loop pass.",
  },
  {
    key: "EMPTY_POLL_LIMIT",
    type: "int",
    group: "execution",
    label: "Empty polls before idle",
    help:
      "Consecutive empty polls before the run (or a pool worker) stops: a no_work tick, or " +
      "an idle maintenance tick whose scans filed nothing (they call no model, so they do " +
      "not keep the run alive or consume the day cap)." +
      " A change applies from the next loop pass.",
  },
  {
    key: "MAX_CONCURRENT_TICKETS_PER_REPO",
    type: "int",
    group: "execution",
    label: "Max in-flight tickets / repo",
    help: "Cap on tickets worked at once within one repo.",
  },
  {
    key: "MAX_CANDIDATES",
    type: "int",
    group: "execution",
    label: "Max candidates scanned",
    help: "Upper bound on ready tickets the scheduler considers each tick.",
  },

  // --- Budget / caps (cont.): retries, CI polling, open-work ceilings ---
  {
    key: "GAFFER_MAX_DELIVERY_ATTEMPTS",
    type: "int",
    group: "budget",
    label: "Max delivery attempts",
    help: "How many times a ticket may be re-worked after a rejected review before it parks to blocked.",
  },
  {
    key: "DISPATCH_MAX_ATTEMPTS",
    type: "int",
    group: "budget",
    label: "Max review rejections (Dispatch)",
    help:
      "Dispatch's own cap on how many times a delivery may be rejected back into the " +
      "queue before the ticket is parked (blocked) for a human — the server-side " +
      "wallet guard against an unbounded reject loop, enforced on every reject " +
      "transition regardless of which runner drove it. Defaults to Max delivery " +
      "attempts so the two caps agree; set it only to make the server stricter or " +
      "looser than the runner's rework ladder.",
  },
  {
    key: "GAFFER_MAX_NOCOMMIT_FAILURES",
    type: "int",
    group: "budget",
    label: "Max no-commit failures",
    help:
      "Cross-run bound on deliveries that crash before committing. After this many " +
      "no-commit/wrong-branch failures the ticket parks visibly to blocked instead of " +
      "being re-picked (and re-billed) every run. Defaults to Max delivery attempts.",
  },
  {
    key: "GAFFER_REWORK_BUDGET_USD",
    type: "string",
    group: "budget",
    label: "Per-ticket rework budget (USD)",
    help:
      "Cumulative spend ceiling for one ticket's rework loop, counting every agent call " +
      "booked to the ticket (delivery, review, security review, clarify, eval judge). " +
      "Delivery stops at whichever hits first — this or Max delivery attempts — then " +
      "parks to blocked. Defaults to the " +
      "factory Budget ceiling; empty = no per-ticket cap (attempts alone bound it).",
  },
  {
    key: "GAFFER_PAUSE_ON_CAP",
    type: "boolean",
    group: "budget",
    label: "Pause on budget cap",
    help: "When the spend ceiling is hit, pause in-flight work instead of hard-stopping.",
  },
  {
    key: "GAFFER_CI_POLL_ATTEMPTS",
    type: "int",
    group: "budget",
    label: "CI poll attempts",
    help: "How many times to poll CI checks (when Require-CI is on) before giving up.",
  },
  {
    key: "GAFFER_CI_POLL_INTERVAL_SECS",
    type: "int",
    group: "budget",
    label: "CI poll interval (s)",
    help: "Seconds between CI check polls.",
  },
  {
    key: "MAX_OPEN_AGENT_BRANCHES_PER_REPO",
    type: "int",
    group: "budget",
    label: "Max open agent branches / repo",
    help: "Ceiling on undelivered agent branches per repo — backpressure so work merges before more starts.",
  },
  {
    key: "MAX_OPEN_AGENT_PRS_PER_REPO",
    type: "int",
    group: "budget",
    label: "Max open agent PRs / repo",
    help: "Ceiling on open agent-authored PRs per repo.",
  },

  // --- Idle loops (cont.): the other between-work loops ---
  {
    key: "CLARIFY_DRAFTS_WHEN_IDLE",
    type: "boolean",
    group: "idle-loops",
    label: "Clarify vague drafts when idle",
    help:
      "When idle, run the clarify pass over vague draft tickets to sharpen their acceptance " +
      "criteria and raise blocking decisions (one paid agent call per draft, once per run). " +
      "A draft with no linked repo on disk (a greenfield epic's tickets before the bootstrap " +
      "links one) is skipped and logged, and the pass moves on to the next draft.",
  },
  {
    key: "IDLE_DRAFT_WHEN_IDLE",
    type: "boolean",
    group: "idle-loops",
    label: "Run every idle scan when idle (legacy)",
    help:
      "When idle AND the maintenance lane is off (or failed), run ALL enabled crew idle " +
      "loops in one pass plus GitHub/Jira ingest and the lore-gap / feature-backlog loops. " +
      "Superseded by the maintenance lane in the Idle loops panel, which runs one " +
      "prioritised lane per idle tick (rotating), does the same ingest + async loops, and " +
      "can promote its own drafts. A tick that files nothing is an empty poll.",
  },

  // --- Quality gates: the runner's DoD guards on every delivery ---
  {
    key: "HYGIENE_ENFORCE",
    type: "boolean",
    group: "quality",
    label: "Enforce repo hygiene",
    help: "Reject deliveries that touch forbidden paths (node_modules, .claude/, factory internals). On by default.",
  },
  {
    key: "MINIMALISM_REQUIRE_NOTE",
    type: "boolean",
    group: "quality",
    label: "Require a smallest-change note",
    help: "On: a delivery that records no smallest-change note goes back to rework instead of review. Off (default): it goes to review flagged needs_human_review. Oversized diffs are always flagged, never failed.",
  },
  {
    key: "OVERSIZED_MAX_FILES",
    type: "int",
    group: "quality",
    label: "Oversized: max files",
    help: "A diff touching more than this many files is flagged needs_human_review: oversized_diff (a flag, never a fail; 0 turns the files cap off).",
  },
  {
    key: "OVERSIZED_MAX_LINES",
    type: "int",
    group: "quality",
    label: "Oversized: max lines",
    help: "A diff changing more than this many lines is flagged needs_human_review: oversized_diff (a flag, never a fail; 0 turns the lines cap off).",
  },

  // --- Sandbox: optional OS-level execution confinement ---
  {
    key: "STRICT_MODE",
    type: "boolean",
    group: "sandbox",
    label: "Strict execution sandbox",
    help:
      "Wrap agent commands in the OS sandbox (SANDBOX_PROVIDER: docker, or sandbox-exec " +
      "on macOS) for defence-in-depth. Off → the permission-hook guard only. On by " +
      "default (and required) in the autonomous, strict and lite modes, where no " +
      "human reviews the work before it ships.",
  },
  {
    key: "STRICT_ALLOW_NETWORK",
    type: "boolean",
    group: "sandbox",
    label: "Allow network in sandbox",
    help: "When the strict sandbox is on, still permit outbound network (package installs, git, the model API).",
  },
  {
    key: "SANDBOX_PROVIDER",
    type: "string",
    choices: ["sandbox-exec", "docker", "none"],
    group: "sandbox",
    label: "Sandbox provider",
    help:
      "Which OS-level containment backend the strict sandbox uses: docker " +
      "(experimental — real read + write + egress isolation, any host with a Docker " +
      "daemon) · sandbox-exec (macOS — write-only containment) · none (disable OS " +
      "wrapping, keep the toggle). Only consulted when the strict sandbox is on.",
  },
  {
    key: "STRICT_ALLOW_HOME",
    type: "string",
    group: "sandbox",
    label: "Sandbox writable HOME paths",
    help:
      "Space-separated HOME paths the strict sandbox may write to outside the worktree " +
      "(Claude Code keeps state/cache here; denying them breaks legitimate runtime writes). " +
      "Defaults to ~/.claude and ~/.cache.",
  },
] as const;

/** Fast lookup of a known key → its descriptor. */
const DEF_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** True iff `key` is one of the known, writable setting keys. */
export function isKnownSetting(key: string): boolean {
  return DEF_BY_KEY.has(key);
}

/**
 * Resolve the settings file path. Precedence: explicit override → `$GAFFER_DATA`
 * → `~/.gaffer` (a bare fallback used only when `$GAFFER_DATA` is unset). When
 * launched via the runner, `$GAFFER_DATA` is set to the repo-local `.gaffer/`
 * (next to the checkout), so that path wins. Always `settings.json`.
 */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.GAFFER_DATA ?? "").trim();
  const base = dataDir !== "" ? resolve(dataDir) : join(homedir(), ".gaffer");
  return join(base, "settings.json");
}

/**
 * Read the persisted settings map. A missing file is the normal "nothing set
 * yet" state and yields `{}`. A present-but-unreadable / malformed file throws a
 * {@link DispatchError} so the API surfaces a clean error rather than silently
 * losing the operator's saved config.
 */
export function readSettingsFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A missing file is expected (nothing saved yet) → empty map.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DispatchError("INTERNAL_ERROR", `Could not read settings file: ${describe(err)}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DispatchError("INTERNAL_ERROR", "Settings file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DispatchError("INTERNAL_ERROR", "Settings file must be a flat JSON object.");
  }
  // Keep only string values for known keys; ignore anything stale/foreign so a
  // hand-edited file can never inject an unknown key into the UI.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isKnownSetting(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * The autonomy posture each GAFFER_MODE implies — a MIRROR of the `case
 * "$GAFFER_MODE"` block in runner/factory.config.sh. The runner fills these with
 * `:=` (only when unset) after settings.json, so a stored value wins over the
 * mode; the API applies the same precedence so the dashboard shows the value the
 * tick will actually use, and so its own gates (agent approve, testing lane)
 * agree with the runner. Unknown mode ⇒ supervised (the safe posture).
 *
 * STRICT_MODE mirrors the runner's "autonomy REQUIRES containment" block: every
 * mode that lets an agent approve or ship without a human (autonomous, strict,
 * lite) defaults GAFFER_STRICT_REQUIRE=1 there, which defaults STRICT_MODE=1, so
 * the OS sandbox is on (and mandatory) in those modes. Omitting it here made the
 * panel report the sandbox OFF when the runner forces it on. The runner skips that
 * default for autonomous/lite when the operator sets GAFFER_STRICT_REQUIRE=0 (see
 * {@link presetsFor}); graduated turns it on only once an `auto` policy row exists,
 * which this static table cannot see.
 */
export const MODE_PRESETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  autonomous: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "1",
    MERGE_ON_AGENT_REVIEW: "1",
    AUTO_MERGE: "1",
    GAFFER_AUTO_PUSH: "1",
    MEMORY_AUTO_APPROVE: "1",
    STRICT_MODE: "1",
  },
  strict: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "1",
    MERGE_ON_AGENT_REVIEW: "1",
    AUTO_MERGE: "1",
    GAFFER_AUTO_PUSH: "1",
    MEMORY_AUTO_APPROVE: "1",
    STRICT_MODE: "1",
  },
  lite: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "1",
    MERGE_ON_AGENT_REVIEW: "0",
    AUTO_MERGE: "0",
    GAFFER_AUTO_PUSH: "0",
    MEMORY_AUTO_APPROVE: "0",
    STRICT_MODE: "1",
  },
  graduated: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "0",
    MERGE_ON_AGENT_REVIEW: "0",
    AUTO_MERGE: "0",
    GAFFER_AUTO_PUSH: "0",
    MEMORY_AUTO_APPROVE: "0",
  },
  supervised: {
    REVIEW_MODE: "human",
    DISPATCH_ALLOW_AGENT_APPROVE: "0",
    MERGE_ON_AGENT_REVIEW: "0",
    AUTO_MERGE: "0",
    GAFFER_AUTO_PUSH: "0",
    MEMORY_AUTO_APPROVE: "0",
  },
};

/** True for the runner's truthy flag spellings (factory.config.sh _gaffer_flag_on). */
function flagOn(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

/**
 * The preset for `mode` as the runner will apply it in `env`: unknown ⇒ supervised,
 * and the STRICT_MODE default dropped where the runner would not apply it — outside
 * `strict`, an operator's explicit GAFFER_STRICT_REQUIRE=0 opts out of it.
 */
export function presetsFor(
  mode: string,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const base = MODE_PRESETS[mode] ?? MODE_PRESETS["supervised"]!;
  const req = env["GAFFER_STRICT_REQUIRE"];
  if (mode !== "strict" && base["STRICT_MODE"] !== undefined && req !== undefined && !flagOn(req)) {
    const { STRICT_MODE: _drop, ...rest } = base;
    return rest;
  }
  return base;
}

/** Where a setting's effective value came from (see {@link SettingView.source}). */
export type SettingSource = "env" | "file" | "mode" | "default";

/**
 * Keys this process set on its OWN env from settings.json or a mode preset (see
 * {@link applySettingsToEnv}). They are NOT operator env overrides, so they are
 * never reported env-locked — the UI may still edit them.
 */
const DERIVED_BY_ENV = new WeakMap<object, Map<string, SettingSource>>();
function derivedOf(env: NodeJS.ProcessEnv): Map<string, SettingSource> {
  let m = DERIVED_BY_ENV.get(env);
  if (!m) {
    m = new Map();
    DERIVED_BY_ENV.set(env, m);
  }
  return m;
}

/**
 * Apply settings.json, then the GAFFER_MODE presets, to `env` as DEFAULTS (never
 * overwriting a key the operator set in the real environment) — the same
 * precedence runner/factory.config.sh gives the runner. Call once at API startup
 * so every env reader in this process (autonomy gates, notifier, testing lane)
 * sees what the dashboard stores, and again after each write so a change takes
 * effect without a restart. Returns the keys it set.
 */
export function applySettingsToEnv(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): { applied: string[] } {
  const file = readSettingsFile(path);
  const applied: string[] = [];
  const isReal = (k: string) =>
    Object.prototype.hasOwnProperty.call(env, k) && !derivedOf(env).has(k);
  for (const [k, v] of Object.entries(file)) {
    if (isReal(k)) continue;
    if (v === "") {
      // An empty stored value means "cleared back to the default": drop any value
      // this process derived earlier so the mode preset / default applies again.
      if (derivedOf(env).has(k)) {
        delete env[k];
        derivedOf(env).delete(k);
      }
      continue;
    }
    env[k] = v;
    derivedOf(env).set(k, "file");
    applied.push(k);
  }
  const mode = (env["GAFFER_MODE"] ?? "").trim();
  const presets = presetsFor(mode, env);
  for (const [k, v] of Object.entries(presets)) {
    if (isReal(k)) continue;
    if (derivedOf(env).get(k) === "file") continue;
    env[k] = v;
    derivedOf(env).set(k, "mode");
    applied.push(k);
  }
  return { applied };
}

/** True iff the OPERATOR set this key in the real environment (not this process). */
export function isEnvLocked(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key) && !derivedOf(env).has(key);
}

/** Test seam: forget every derived key (a fresh process). */
export function resetDerivedSettings(env: NodeJS.ProcessEnv = process.env): void {
  derivedOf(env).clear();
}

/**
 * Build the per-setting views GET /api/settings returns: for each known setting,
 * its current file value (or "" when unset), the value the factory will actually
 * use (`effective`) and where that came from, plus whether it is env-locked.
 */
export function listSettings(
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): SettingView[] {
  const file = readSettingsFile(path);
  const mode = (env["GAFFER_MODE"] ?? file["GAFFER_MODE"] ?? "").trim();
  const presets = presetsFor(mode, env);
  return SETTING_DEFS.map((def) => {
    const locked = isEnvLocked(env, def.key);
    const fileValue = file[def.key] ?? "";
    let effective: string;
    let source: SettingSource;
    if (locked) {
      effective = env[def.key] ?? "";
      source = "env";
    } else if (fileValue !== "") {
      effective = fileValue;
      source = "file";
    } else if (presets[def.key] !== undefined) {
      effective = presets[def.key]!;
      source = "mode";
    } else {
      effective = "";
      source = "default";
    }
    return {
      key: def.key,
      value: fileValue,
      effective,
      source,
      envLocked: locked,
      type: def.type,
      group: def.group,
      label: def.label,
      ...(def.help !== undefined ? { help: def.help } : {}),
      ...(def.choices !== undefined ? { choices: def.choices } : {}),
    };
  });
}

/** Outcome of a settings write: which keys persisted and which were rejected. */
export interface WriteSettingsResult {
  readonly written: string[];
  /** Known keys skipped because they are env-locked (env overrides the file). */
  readonly rejected: string[];
  /** Unknown keys silently dropped (not in the allow-list). */
  readonly ignored: string[];
  /** Known enum keys skipped because the value wasn't one of the allowed choices. */
  readonly invalid: string[];
}

/**
 * Merge `updates` into the persisted settings and write atomically.
 *
 * Rules:
 *   - Unknown keys are dropped (not in {@link SETTING_DEFS}) → `ignored`.
 *   - env-locked keys are refused (env overrides the file, so a UI edit would be
 *     a silent no-op for the runner) → `rejected`, never persisted.
 *   - Everything else is merged onto the existing file map and written.
 *
 * Atomic write: serialise to a temp file in the same directory, then rename over
 * the target, so a crash mid-write never leaves a truncated settings file.
 */
export function writeSettings(
  updates: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  path: string = resolveSettingsPath(env),
): WriteSettingsResult {
  const current = readSettingsFile(path);
  const merged: Record<string, string> = { ...current };
  const written: string[] = [];
  const rejected: string[] = [];
  const ignored: string[] = [];
  const invalid: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const def = SETTING_DEFS.find((d) => d.key === key);
    if (def === undefined) {
      ignored.push(key);
      continue;
    }
    if (isEnvLocked(env, key)) {
      // env-locked: an explicit env var overrides the file, so persisting this
      // would mislead the operator (the runner would ignore it). Refuse it.
      rejected.push(key);
      continue;
    }
    // Enum settings only accept a listed choice. An empty value is always
    // allowed — it clears the override back to the built-in default.
    if (def.choices !== undefined && value !== "" && !def.choices.includes(value)) {
      invalid.push(key);
      continue;
    }
    // Typed values must parse: an `int` is a non-negative integer literal; a `boolean`
    // is 0/1/true/false/yes/no. Previously any string was persisted for any type, so a
    // typo'd cap silently became "unset" at runtime (bash `[ "$x" -ge … ]` on "abc").
    if (value !== "" && !valueFitsType(def.type, value)) {
      invalid.push(key);
      continue;
    }
    // Outbound URLs (notify webhook / Slack) must pass the notify URL policy: http(s)
    // only and no loopback / link-local / private destination unless the env opts in.
    // The dashboard token would otherwise let anyone aim the factory's POSTs at an
    // internal service (SSRF) from the settings panel.
    if (value !== "" && key.endsWith("_URL")) {
      const problem = notifyUrlProblem(value, { allowPrivate: notifyAllowsPrivate(env) });
      if (problem !== null) {
        invalid.push(key);
        continue;
      }
    }
    merged[key] = value;
    written.push(key);
  }

  // Only touch the disk when something actually changed.
  if (written.length > 0) {
    atomicWriteJson(path, merged);
    // Take effect in THIS process immediately (its own gates read env): drop what
    // was derived earlier so a cleared key falls back to its preset, then re-apply.
    for (const k of written) {
      if (derivedOf(env).has(k)) {
        delete env[k];
        derivedOf(env).delete(k);
      }
    }
    // A mode change re-derives every preset key that is not stored explicitly.
    if (written.includes("GAFFER_MODE")) {
      for (const k of [...derivedOf(env).keys()]) {
        if (derivedOf(env).get(k) === "mode") {
          delete env[k];
          derivedOf(env).delete(k);
        }
      }
    }
    applySettingsToEnv(env, path);
  }

  return { written, rejected, ignored, invalid };
}

/** Does `value` parse as the setting's declared type? (Empty is handled by the caller.) */
function valueFitsType(type: SettingType, value: string): boolean {
  switch (type) {
    case "int":
      return /^\d+$/.test(value.trim());
    case "boolean":
      return /^(0|1|true|false|yes|no)$/i.test(value.trim());
    default:
      return true;
  }
}

/** Serialise `data` to `path` atomically (temp file in the same dir + rename). */
function atomicWriteJson(path: string, data: Record<string, string>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Random suffix (not Date.now()) so two writes in the same millisecond on the
  // same pid can't collide on the temp path and clobber each other's contents.
  const tmp = join(dir, `.settings.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // A failed rename (cross-device, permissions) must not leave the temp file
    // littering the data dir — clean it up best-effort, then surface the error.
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw err;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
