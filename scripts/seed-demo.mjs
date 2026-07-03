#!/usr/bin/env node
/**
 * seed-demo.mjs — neutral TaskFlow demo dataset for README screenshots.
 *
 * Creates an isolated DB under $DEMO_DIR (default /tmp/gaffer-demo-seed).
 * The "TaskFlow" product is a fictional task-management API + web client.
 *
 * Usage:
 *   node scripts/seed-demo.mjs            # uses /tmp/gaffer-demo-seed
 *   DEMO_DIR=/my/path node scripts/seed-demo.mjs
 *
 * Outputs (stdout):
 *   DISPATCH_DB=<path>
 *   MEMORY_DB=<path>
 *   MEMORY_CLI_BIN=<path>
 *   DISPATCH_API_PORT=8791
 *
 * No banned terms appear in any seeded content.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAFFER_HOME = resolve(__dirname, "..");

const DEMO_DIR = process.env.DEMO_DIR ?? "/tmp/gaffer-demo-seed";
const DISPATCH_DB = `${DEMO_DIR}/dispatch.sqlite`;
const MEMORY_DB = `${DEMO_DIR}/memory.sqlite`;
const SQLITE3 = process.env.SQLITE3 ?? "sqlite3";

const DISPATCH_DIR = `${GAFFER_HOME}/packages/dispatch`;
const MEMORY_DIR = `${GAFFER_HOME}/packages/memory`;
const MEMORY_CLI_BIN = `${MEMORY_DIR}/dist/bin/memory.js`;

// ─── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[seed-demo] ${msg}\n`);
}

function wg(...args) {
  const result = spawnSync(
    "node",
    [`${DISPATCH_DIR}/dist/cli/index.js`, "--db", DISPATCH_DB, ...args],
    { encoding: "utf8", env: { ...process.env, DISPATCH_DB } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wg ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
  }
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sql(query) {
  const result = spawnSync(SQLITE3, [DISPATCH_DB, query], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr}\nQuery: ${query}`);
  }
  return result.stdout.trim();
}

function lg(...args) {
  const result = spawnSync("node", [MEMORY_CLI_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_DB },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`lg ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
  }
  return result.stdout.trim();
}

// Move a ticket to an arbitrary status bypassing state-machine via SQLite
function forceStatus(ticketNumber, status) {
  sql(
    `UPDATE tickets SET status='${status}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), row_version=row_version+1 WHERE number=${ticketNumber};`,
  );
}

// ─── 0. clean slate ───────────────────────────────────────────────────────────

log(`Resetting demo dir: ${DEMO_DIR}`);
if (existsSync(DEMO_DIR)) rmSync(DEMO_DIR, { recursive: true });
mkdirSync(DEMO_DIR, { recursive: true });

// Minimal git repos as backing paths
const apiRepoPath = `${DEMO_DIR}/taskflow-api`;
const webRepoPath = `${DEMO_DIR}/taskflow-web`;
mkdirSync(apiRepoPath);
mkdirSync(webRepoPath);
execSync(
  `git init -q -b main && git -c user.email=demo@taskflow.example -c user.name="TaskFlow" commit -q --allow-empty -m init`,
  { cwd: apiRepoPath },
);
execSync(
  `git init -q -b main && git -c user.email=demo@taskflow.example -c user.name="TaskFlow" commit -q --allow-empty -m init`,
  { cwd: webRepoPath },
);

// ─── 1. Dispatch DB init ──────────────────────────────────────────────────────

log("Initialising dispatch DB");
wg("init");

// ─── 2. Repos ─────────────────────────────────────────────────────────────────

log("Registering repos");
wg(
  "repo",
  "add",
  "-n",
  "taskflow-api",
  "--path",
  apiRepoPath,
  "--stack",
  "node",
  "--test",
  "pnpm test",
  "--lint",
  "pnpm lint",
);
wg(
  "repo",
  "add",
  "-n",
  "taskflow-web",
  "--path",
  webRepoPath,
  "--stack",
  "react",
  "--test",
  "pnpm test",
  "--lint",
  "pnpm lint",
);

// ─── 3. Scope nodes (Factory Map) ─────────────────────────────────────────────

log("Creating scope nodes");
const snApi = wg(
  "scope",
  "node",
  "create",
  "-n",
  "API Core",
  "-t",
  "service",
  "-d",
  "REST API surface — auth, tasks, webhooks",
  "--risk",
  "medium",
);
const snWeb = wg(
  "scope",
  "node",
  "create",
  "-n",
  "Web Client",
  "-t",
  "product",
  "-d",
  "Browser SPA for end users",
  "--risk",
  "low",
);
const snPlatform = wg(
  "scope",
  "node",
  "create",
  "-n",
  "Shared Platform",
  "-t",
  "domain",
  "-d",
  "Cross-cutting concerns: logging, config, rate-limiting",
  "--risk",
  "medium",
);

// Edges: Platform → API, Platform → Web
const apiNodeId = snApi?.node?.id ?? "";
const webNodeId = snWeb?.node?.id ?? "";
const platformNodeId = snPlatform?.node?.id ?? "";

if (platformNodeId && apiNodeId) {
  wg("scope", "edge", "add", platformNodeId, apiNodeId);
}
if (platformNodeId && webNodeId) {
  wg("scope", "edge", "add", platformNodeId, webNodeId);
}

// Link repos to scope nodes
if (apiNodeId) {
  wg("scope", "repo", "link", apiNodeId, "taskflow-api");
}
if (webNodeId) {
  wg("scope", "repo", "link", webNodeId, "taskflow-web");
}

// ─── 4. Tickets ───────────────────────────────────────────────────────────────

log("Creating tickets");

// ── done ──
wg(
  "ticket",
  "create",
  "-t",
  "Bootstrap project monorepo",
  "-d",
  "Initialise the pnpm monorepo: packages/api + packages/web, shared tsconfig, lint config, CI skeleton.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "1", "-t", "pnpm install succeeds from root with no errors");
wg("ac", "add", "1", "-t", "CI pipeline runs lint + tests on every PR");
forceStatus(1, "done");

wg(
  "ticket",
  "create",
  "-t",
  "Design the core task data model",
  "-d",
  "Define the Task entity: id, title, description, due_date, priority, labels, assignee, status, created_at.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "2", "-t", "Migration creates the tasks table with all columns");
wg("ac", "add", "2", "-t", "Seeded with 20 fixture tasks for local dev");
forceStatus(2, "done");

// ── in_review ──
wg(
  "ticket",
  "create",
  "-t",
  "OAuth login (Google + GitHub)",
  "-d",
  "Social login via OAuth2. Support Google and GitHub providers. Store identity in user_identities. Include token refresh.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "3", "-t", "Google OAuth flow completes and issues a session cookie");
wg("ac", "add", "3", "-t", "GitHub OAuth flow completes and issues a session cookie");
wg("ac", "add", "3", "-t", "Token refresh extends session without re-login prompt");
wg("repo", "link", "3", "taskflow-api");
forceStatus(3, "in_review");

// ── in_progress ──
wg(
  "ticket",
  "create",
  "-t",
  "Rate-limit the public API",
  "-d",
  "Sliding-window rate limits per IP and per API token on all public endpoints. Return 429 with Retry-After header.",
  "-p",
  "solo_loose",
  "--risk",
  "high",
);
wg("ac", "add", "4", "-t", "Exceeding 100 req/min returns 429 with Retry-After");
wg("ac", "add", "4", "-t", "X-RateLimit-* headers present on every response");
wg("repo", "link", "4", "taskflow-api");
forceStatus(4, "in_progress");

wg(
  "ticket",
  "create",
  "-t",
  "Dark mode for the web client",
  "-d",
  "System-preference-aware dark theme via CSS custom properties. Persist toggle in localStorage. WCAG AA contrast on both themes.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "5", "-t", "Theme follows prefers-color-scheme on first load");
wg("ac", "add", "5", "-t", "Manual toggle persists across browser sessions");
wg("repo", "link", "5", "taskflow-web");
forceStatus(5, "in_progress");

// ── ready ──
wg(
  "ticket",
  "create",
  "-t",
  "CSV export of tasks",
  "-d",
  "Download task list as CSV. All visible columns included; active filters respected. Max 10 000 rows per export.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "6", "-t", "Download triggers a CSV with correct column headers");
wg("ac", "add", "6", "-t", "Active label filter is reflected in the exported rows");
wg("repo", "link", "6", "taskflow-api");
wg("repo", "link", "6", "taskflow-web");
wg("ticket", "ready", "6");

wg(
  "ticket",
  "create",
  "-t",
  "Daily email digest of due tasks",
  "-d",
  "Scheduled email listing tasks due in the next 48 hours. Delivered at 08:00 in the user's timezone. Opt-out in account settings.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "7", "-t", "Digest sent at 08:00 in the user's configured timezone");
wg("ac", "add", "7", "-t", "Opt-out link in email unsubscribes immediately");
wg("repo", "link", "7", "taskflow-api");
wg("ticket", "ready", "7");

// ── draft ──
wg(
  "ticket",
  "create",
  "-t",
  "Task labels and filters",
  "-d",
  "Colour-coded labels per workspace. Filter board by one or more labels. Labels are created and managed by workspace owners.",
  "-p",
  "solo_loose",
);

wg(
  "ticket",
  "create",
  "-t",
  "Activity audit log",
  "-d",
  "Immutable audit_log table recording every mutation: create, update, status change, assignment change. Queryable via API.",
  "-p",
  "solo_loose",
  "--risk",
  "medium",
);

// ── blocked ──
wg(
  "ticket",
  "create",
  "-t",
  "Webhook delivery for task events",
  "-d",
  "Fire HTTP webhooks on task create/update/complete events. Configurable endpoint per workspace; exponential-backoff retry.",
  "-p",
  "solo_loose",
);
wg("ac", "add", "10", "-t", "Webhook fires within 5s of a task event");
wg("ac", "add", "10", "-t", "Failed deliveries retry with exponential back-off up to 24h");
wg("repo", "link", "10", "taskflow-api");
forceStatus(10, "blocked");

// ─── 5. Epic: Recurring tasks ─────────────────────────────────────────────────

log("Creating Recurring Tasks epic");
const epicPlan = {
  epic: {
    name: "Recurring Tasks",
    description:
      "End-to-end recurring-tasks feature: data model, scheduler, UI controls, and digest notifications.",
  },
  tickets: [
    {
      title: "Recurring task data model",
      description:
        "Extend Task with recurrence_rule (iCal RRULE string), next_due_at (timestamp), and parent_task_id FK for generated instances.",
      acceptanceCriteria: [
        "Migration adds recurrence_rule, next_due_at, parent_task_id without downtime",
        "parent_task_id FK enforces cascade delete of child instances",
      ],
      priority: 10,
    },
    {
      title: "Recurrence scheduler service",
      description:
        "Background job that materialises the next task instance when a recurring task is completed or its due date passes. Runs every 5 minutes.",
      acceptanceCriteria: [
        "Next instance created within 5 minutes of parent completion",
        "No duplicate instances for the same parent + due-date pair",
      ],
      priority: 9,
      dependsOn: [0],
    },
    {
      title: "Recurring task UI controls",
      description:
        "Add a Repeat picker to the task creation and edit forms. Show a recurrence badge on task cards in the board view.",
      acceptanceCriteria: [
        "Picker supports daily / weekly / monthly / custom RRULE",
        "Recurrence badge visible on card and in the detail drawer",
      ],
      priority: 8,
      dependsOn: [0],
    },
    {
      title: "Recurring tasks in digest notifications",
      description:
        "Extend the daily email digest to list upcoming recurring task instances for the next 7 days in a dedicated section.",
      acceptanceCriteria: [
        "Digest includes a 'Recurring this week' section with correct instances",
        "Each instance links back to the parent recurring task",
      ],
      priority: 7,
      dependsOn: [1, 2],
    },
  ],
};

const epicJsonPath = `${DEMO_DIR}/epic-recurring.json`;
writeFileSync(epicJsonPath, JSON.stringify(epicPlan, null, 2));
wg("epic", "create", epicJsonPath);

// Epic tickets are #11–14. Move them to meaningful states.
// #11 (data model) → in_review
wg("repo", "link", "11", "taskflow-api");
forceStatus(11, "in_review");

// #12 (scheduler) → in_progress (depends on #11 which is in_review)
wg("repo", "link", "12", "taskflow-api");
forceStatus(12, "in_progress");

// #13 (UI) stays draft (depends on #11 not yet done)
wg("repo", "link", "13", "taskflow-web");

// #14 (digest) stays draft (depends on #12 + #13)
wg("repo", "link", "14", "taskflow-api");

// ─── 6. Scope links on tickets ────────────────────────────────────────────────

if (apiNodeId) {
  for (const n of [3, 4, 6, 7, 10, 11, 12, 14]) {
    try {
      wg("ticket", "scope", "link", String(n), apiNodeId);
    } catch {}
  }
}
if (webNodeId) {
  for (const n of [5, 6, 13]) {
    try {
      wg("ticket", "scope", "link", String(n), webNodeId);
    } catch {}
  }
}

// ─── 7. Memory seed ───────────────────────────────────────────────────────────

log("Seeding memory");
try {
  lg("init");
  lg("demo", "--force");
} catch (e) {
  log(`Memory seed warning (non-fatal): ${e.message}`);
}

// ─── 7b. Repo digest + feature ledger — so the Memory view renders a real digest
//         and feature ledger instead of the "no digest yet" empty state ────────
log("Seeding repo digest + feature ledger");
try {
  lg("digest", "set", "taskflow-api",
    "--overview", "TaskFlow API — a Fastify + TypeScript service: task CRUD, recurring-task scheduling, and OAuth session auth over a Postgres data model.",
    "--structure", "src/routes (HTTP handlers) · src/db (migrations + repositories) · src/auth (OAuth + sessions) · src/scheduler (recurring expansion) · test (vitest).",
    "--conventions", "TypeScript strict · Zod request validation · repository pattern over the DB · every route carries a vitest integration test.",
    "--stack", "TypeScript · Fastify · Postgres · Zod · vitest",
    "--source", "onboard");
  lg("digest", "set", "taskflow-web",
    "--overview", "TaskFlow web — a React + Vite SPA for tasks, recurring schedules, and the daily digest view.",
    "--structure", "src/components · src/routes · src/api (typed client) · src/hooks · test.",
    "--conventions", "Functional components + hooks · TanStack Query for server state · co-located component tests.",
    "--stack", "TypeScript · React · Vite · TanStack Query",
    "--source", "onboard");
  const feat = (repo, name, summary, status) =>
    lg("feature", "add", repo, "--name", name, "--summary", summary, "--status", status);
  feat("taskflow-api", "Task CRUD API", "Create, read, update, delete tasks over REST.", "shipped");
  feat("taskflow-api", "OAuth session auth", "Google + GitHub OAuth issuing signed session cookies.", "building");
  feat("taskflow-api", "Recurring task scheduler", "Expand recurring rules into concrete task instances.", "building");
  feat("taskflow-api", "Daily digest email", "Email each user their due + upcoming tasks.", "backlog");
  feat("taskflow-web", "Task board UI", "Drag-and-drop board grouped by status.", "shipped");
  feat("taskflow-web", "Recurring task controls", "Define and preview recurrence rules in the UI.", "backlog");
} catch (e) {
  log(`digest/feature seed warning (non-fatal): ${e.message}`);
}

// ─── 7c. A real delivery branch for the in-review ticket (#3), so the Review view
//         renders a server-computed `git diff main...<branch>` instead of the
//         empty "no delivery branch recorded" state ──────────────────────────
log("Seeding a review diff for #3 (OAuth login)");
try {
  const gitc = `git -c user.email=demo@taskflow.example -c user.name="TaskFlow"`;
  mkdirSync(`${apiRepoPath}/src/auth`, { recursive: true });
  writeFileSync(
    `${apiRepoPath}/src/auth/oauth.ts`,
    `import { OAuth2Client } from "../lib/oauth2.js";
import type { FastifyInstance } from "fastify";

// Google + GitHub OAuth → a signed session cookie. Ticket #3.
export function registerOAuthRoutes(app: FastifyInstance) {
  const google = new OAuth2Client("google");
  const github = new OAuth2Client("github");

  app.get("/auth/:provider/start", async (req, reply) => {
    const provider = req.params.provider === "github" ? github : google;
    reply.redirect(provider.authorizeUrl({ scope: ["email"] }));
  });

  app.get("/auth/:provider/callback", async (req, reply) => {
    const provider = req.params.provider === "github" ? github : google;
    const { email } = await provider.exchange(req.query.code);
    const session = await app.sessions.issue(email);
    reply.setCookie("sid", session.token, { httpOnly: true, sameSite: "lax" });
    return { ok: true, email };
  });
}
`,
  );
  execSync(
    `${gitc} checkout -q -b feat/oauth-login && ${gitc} add -A && ${gitc} commit -q -m "feat(auth): OAuth login (Google + GitHub) issuing session cookies"`,
    { cwd: apiRepoPath },
  );
  execSync(`${gitc} checkout -q main`, { cwd: apiRepoPath });
  wg("delivery-artifact", "3", "--branch", "feat/oauth-login", "--diff", "1 file changed, 24 insertions(+)", "--as", "system");

  // #11 — Recurring task data model: its own branch off main (a migration).
  mkdirSync(`${apiRepoPath}/src/db/migrations`, { recursive: true });
  writeFileSync(
    `${apiRepoPath}/src/db/migrations/002_recurring.sql`,
    `-- Recurring task rules: attach a recurrence to a task. Ticket #11.
CREATE TABLE recurrence_rule (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  freq       text NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly')),
  interval   int  NOT NULL DEFAULT 1,
  by_weekday int[],
  until      timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurrence_rule_task_id_idx ON recurrence_rule (task_id);
`,
  );
  execSync(
    `${gitc} checkout -q -b feat/recurring-data-model && ${gitc} add -A && ${gitc} commit -q -m "feat(db): recurrence_rule table + index for recurring tasks"`,
    { cwd: apiRepoPath },
  );
  execSync(`${gitc} checkout -q main`, { cwd: apiRepoPath });
  wg("delivery-artifact", "11", "--branch", "feat/recurring-data-model", "--diff", "1 file changed, 12 insertions(+)", "--as", "system");
} catch (e) {
  log(`review-diff seed warning (non-fatal): ${e.message}`);
}

// ─── 8. Print env for caller ──────────────────────────────────────────────────

log("Seed complete.");
console.log(`DISPATCH_DB=${DISPATCH_DB}`);
console.log(`MEMORY_DB=${MEMORY_DB}`);
console.log(`MEMORY_CLI_BIN=${MEMORY_CLI_BIN}`);
console.log(`DISPATCH_API_PORT=8791`);
