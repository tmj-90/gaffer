// The demo world behind scripts/screenshots.mjs: three small TaskFlow repos (real code
// with passing tests), the epics and tickets the factory works through, and the scripted
// change each stub delivery commits (stub-claude.sh, option "steps"). Every ticket here is
// driven through the live path by the screenshot script; nothing in this file is model
// output. Plain product content only: no tool, vendor or model names.

const pkg = (name, bin) =>
  JSON.stringify(
    {
      name,
      version: "0.4.0",
      private: true,
      type: "module",
      ...(bin ? { bin: { taskflow: bin } } : {}),
      scripts: { test: "node --test", lint: 'node -e "process.exit(0)"' },
    },
    null,
    2,
  ) + "\n";

const T = (imports, body) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\n${imports}\n\n${body}\n`;

// ── the repos ───────────────────────────────────────────────────────────────
export const REPOS = {
  "taskflow-core": {
    description: "The TaskFlow domain library: tasks, due dates, labels, digests and the CLI.",
    digest: {
      overview:
        "The TaskFlow domain library: pure functions over plain task lists (tasks, due dates, labels, reminders, the morning digest) and a small CLI in bin/taskflow.js.",
      structure:
        "src/tasks.js (create, complete, rename) · src/board.js (bulk actions, grouping) · src/due.js and src/remind.js (dates) · src/digest.js (the morning email) · bin/taskflow.js (CLI) · test/ (node:test, one file per module).",
      conventions:
        "Every function returns a new list and never mutates its input · the clock is a parameter (now = Date.now()) · one test file per module, plus black-box acceptance tests under test/acceptance.",
      stack: "JavaScript (ES modules) · node:test · no runtime dependencies",
    },
    features: [
      ["Task lifecycle", "Create, complete, reopen, rename and archive tasks.", "shipped"],
      ["Due dates", "Due-soon, tomorrow and overdue views over the task list.", "shipped"],
      [
        "Morning digest",
        "The daily email: subject line and one line per task due soon.",
        "shipped",
      ],
      ["Reminders", "A reminder an hour before a task is due, sent once.", "building"],
      ["Recurring tasks", "Rules that generate the next occurrence when a task closes.", "backlog"],
    ],
    files: {
      "package.json": pkg("taskflow-core", "bin/taskflow.js"),
      "README.md":
        "# taskflow-core\n\nThe TaskFlow domain library: tasks, due dates, labels and the daily digest. Pure functions over plain task lists, plus a small CLI (`bin/taskflow.js`).\n",
      "src/tasks.js": `// Tasks are plain objects: { id, title, done, due, labels }. Every function returns a new list.
export function addTask(list, title, extra = {}) {
  const id = list.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  return [...list, { id, title, done: false, due: null, labels: [], ...extra }];
}

export function completeTask(list, title) {
  return list.map((t) => (t.title === title ? { ...t, done: true } : t));
}

export function renameTask(list, id, title) {
  return list.map((t) => (t.id === id ? { ...t, title } : t));
}
`,
      "src/board.js": `import { completeTask } from "./tasks.js";

// Close every task on the board in one go (the "Finish all" button).
export function finishAll(list) {
  return list.reduce((l, t) => completeTask(l, t.title), list);
}

export function groupByStatus(list) {
  return { open: list.filter((t) => !t.done), done: list.filter((t) => t.done) };
}
`,
      "src/due.js": `const DAY = 24 * 60 * 60 * 1000;

export function dueWithin(list, days, now = Date.now()) {
  return list.filter((t) => !t.done && t.due && Date.parse(t.due) - now <= days * DAY);
}

export function overdue(list, now = Date.now()) {
  return list.filter((t) => !t.done && t.due && Date.parse(t.due) < now);
}
`,
      "src/digest.js": `import { dueWithin } from "./due.js";

// The lines of the morning digest email: one per task due in the next two days.
export function digestLines(list, now = Date.now()) {
  return dueWithin(list, 2, now).map((t) => \`- \${t.title} (due \${t.due.slice(0, 10)})\`);
}
`,
      "src/labels.js": `export function addLabel(task, label) {
  return task.labels.includes(label) ? task : { ...task, labels: [...task.labels, label] };
}

export function byLabel(list, label) {
  return list.filter((t) => t.labels.includes(label));
}
`,
      "bin/taskflow.js": `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { overdue } from "../src/due.js";

const [cmd, ...rest] = process.argv.slice(2);
const file = rest[rest.indexOf("--file") + 1];
const list = JSON.parse(readFileSync(file, "utf8"));
if (cmd === "count") console.log(\`open: \${list.filter((t) => !t.done).length}\`);
else if (cmd === "overdue") for (const t of overdue(list)) console.log(t.title);
else {
  console.error(\`unknown command: \${cmd}\`);
  process.exit(2);
}
`,
      "test/fixtures/tasks.json":
        JSON.stringify(
          [
            { id: 1, title: "Renew the domain", done: false, due: "2020-01-02", labels: [] },
            { id: 2, title: "Plan the offsite", done: false, due: null, labels: ["team"] },
            { id: 3, title: "Pay the invoice", done: true, due: "2020-01-01", labels: [] },
          ],
          null,
          2,
        ) + "\n",
      "test/tasks.test.js": T(
        'import { addTask, completeTask, renameTask } from "../src/tasks.js";',
        `test("addTask appends an open task with the next id", () => {
  const l = addTask(addTask([], "a"), "b");
  assert.deepEqual(l.map((t) => [t.id, t.done]), [[1, false], [2, false]]);
});
test("completeTask marks the named task done", () => {
  assert.equal(completeTask(addTask([], "a"), "a")[0].done, true);
});
test("renameTask renames by id", () => {
  assert.equal(renameTask(addTask([], "a"), 1, "b")[0].title, "b");
});`,
      ),
      "test/board.test.js": T(
        'import { finishAll, groupByStatus } from "../src/board.js";',
        `test("finishAll closes every task", () => {
  assert.ok(finishAll([{ title: "a", done: false }]).every((t) => t.done));
});
test("groupByStatus splits open and done", () => {
  assert.equal(groupByStatus([{ done: true }, { done: false }]).open.length, 1);
});`,
      ),
      "test/due.test.js": T(
        'import { dueWithin, overdue } from "../src/due.js";',
        `const now = Date.parse("2026-05-01T09:00:00Z");
const list = [
  { title: "soon", done: false, due: "2026-05-02T09:00:00Z" },
  { title: "late", done: false, due: "2026-04-30T09:00:00Z" },
  { title: "far", done: false, due: "2026-06-01T09:00:00Z" },
];
test("dueWithin keeps tasks due in the window", () => {
  assert.deepEqual(dueWithin(list, 2, now).map((t) => t.title), ["soon", "late"]);
});
test("overdue keeps tasks past their date", () => {
  assert.deepEqual(overdue(list, now).map((t) => t.title), ["late"]);
});`,
      ),
      "test/digest.test.js": T(
        'import { digestLines } from "../src/digest.js";',
        `test("digestLines lists what is due in two days", () => {
  const now = Date.parse("2026-05-01T09:00:00Z");
  assert.deepEqual(digestLines([{ title: "Ship", done: false, due: "2026-05-02T00:00:00Z" }], now), [
    "- Ship (due 2026-05-02)",
  ]);
});`,
      ),
      "test/labels.test.js": T(
        'import { addLabel, byLabel } from "../src/labels.js";',
        `test("addLabel is idempotent", () => {
  const t = addLabel(addLabel({ labels: [] }, "home"), "home");
  assert.deepEqual(t.labels, ["home"]);
});
test("byLabel filters", () => {
  assert.equal(byLabel([{ labels: ["a"] }, { labels: [] }], "a").length, 1);
});`,
      ),
    },
  },
  "taskflow-api": {
    description: "The TaskFlow HTTP API: task routes, sessions and rate limits.",
    digest: {
      overview:
        "The TaskFlow HTTP API on node:http: task routes over a store, signed sessions, pagination, ETags, CSV export and a per-token rate limit.",
      structure:
        "src/server.js (route table) · src/routes/ (handlers returning { status, body }) · src/auth/ (sessions) · src/store.js (in-memory store; the database adapter in production) · test/.",
      conventions:
        "Handlers are pure and return { status, body } · signatures compared in constant time · every route has a test that calls it without a socket.",
      stack: "JavaScript (ES modules) · node:http · node:crypto · node:test",
    },
    features: [
      ["Task routes", "List, create, paginate and export tasks.", "shipped"],
      ["Caching", "Weak ETags and 304s on GET /tasks.", "shipped"],
      ["Rate limits", "100 requests a minute per API token, with Retry-After.", "building"],
      ["Session auth", "Signed sessions with expiry, refresh and sign out everywhere.", "building"],
      ["Webhooks", "Task events posted to a configured URL with retries.", "backlog"],
    ],
    files: {
      "package.json": pkg("taskflow-api"),
      "README.md":
        "# taskflow-api\n\nThe TaskFlow HTTP API on node:http: task routes, signed sessions and per-token rate limits.\n",
      "src/store.js": `// In-memory store behind the routes; the production build swaps in the database adapter.
export function createStore(seed = []) {
  let tasks = [...seed];
  return {
    list: () => tasks,
    add(task) {
      tasks = [...tasks, task];
      return task;
    },
  };
}
`,
      "src/routes/tasks.js": `export function listTasks(store, query = {}) {
  const all = store.list();
  return query.open ? all.filter((t) => !t.done) : all;
}

export function createTask(store, body) {
  if (!body || typeof body.title !== "string" || !body.title.trim())
    return { status: 422, body: { error: "title is required" } };
  const task = store.add({ id: store.list().length + 1, title: body.title.trim(), done: false });
  return { status: 201, body: task };
}
`,
      "src/auth/session.js": `import { createHmac, timingSafeEqual } from "node:crypto";

export function issueSession(user, secret, now = Date.now()) {
  const payload = \`\${user}.\${now}\`;
  return \`\${payload}.\${sign(payload, secret)}\`;
}

export function verifySession(token, secret) {
  const i = token.lastIndexOf(".");
  const payload = token.slice(0, i);
  const want = Buffer.from(sign(payload, secret));
  const got = Buffer.from(token.slice(i + 1));
  return want.length === got.length && timingSafeEqual(want, got) ? payload.split(".")[0] : null;
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
`,
      "src/server.js": `import { listTasks, createTask } from "./routes/tasks.js";

// Route table for the node:http server in bin/serve.js.
export function route(store, method, path, body) {
  if (method === "GET" && path === "/tasks") return { status: 200, body: listTasks(store) };
  if (method === "POST" && path === "/tasks") return createTask(store, body);
  return { status: 404, body: { error: "not found" } };
}
`,
      "test/routes.test.js": T(
        'import { createStore } from "../src/store.js";\nimport { route } from "../src/server.js";',
        `test("POST /tasks creates a task", () => {
  const s = createStore();
  assert.equal(route(s, "POST", "/tasks", { title: "Write the brief" }).status, 201);
  assert.equal(route(s, "GET", "/tasks").body.length, 1);
});
test("POST /tasks without a title is a 422", () => {
  assert.equal(route(createStore(), "POST", "/tasks", {}).status, 422);
});`,
      ),
      "test/tasks-route.test.js": T(
        'import { createStore } from "../src/store.js";\nimport { createTask, listTasks } from "../src/routes/tasks.js";',
        `test("listTasks can keep open tasks only", () => {
  const s = createStore([{ id: 1, done: true }, { id: 2, done: false }]);
  assert.equal(listTasks(s, { open: true }).length, 1);
});
test("createTask trims the title", () => {
  assert.equal(createTask(createStore(), { title: " a " }).body.title, "a");
});`,
      ),
      "test/session.test.js": T(
        'import { issueSession, verifySession } from "../src/auth/session.js";',
        `test("a session verifies with its secret only", () => {
  const tok = issueSession("ana", "s1", 1);
  assert.equal(verifySession(tok, "s1"), "ana");
  assert.equal(verifySession(tok, "s2"), null);
});`,
      ),
    },
  },
  "taskflow-web": {
    description: "The TaskFlow web client: board rendering, themes and formatting.",
    digest: {
      overview:
        "The TaskFlow web client: the board rendered as string templates over the API's task shape, with themes, relative dates and keyboard use.",
      structure:
        "src/render/ (card, board, chips, badges, column headers) · src/format.js and src/relative.js (dates) · src/theme.js and src/prefs.js (themes) · test/.",
      conventions:
        "Rendering is string templates, every user string through escape() · preferences read through a storage object so tests pass a Map · no DOM in tests.",
      stack: "JavaScript (ES modules) · node:test · no framework",
    },
    features: [
      ["Board", "Cards with labels, late badges and column counts.", "shipped"],
      ["Themes", "Light and dark, remembered per user.", "shipped"],
      ["Keyboard use", "Complete, reopen and close the drawer from the keyboard.", "building"],
      ["Drag to reorder", "Reorder cards within a column.", "backlog"],
    ],
    files: {
      "package.json": pkg("taskflow-web"),
      "README.md":
        "# taskflow-web\n\nThe TaskFlow web client. Rendering is string templates over the API's task shape, so it tests without a browser.\n",
      "src/render/card.js": `import { formatDue } from "../format.js";

export function renderCard(task, now = Date.now()) {
  const due = task.due ? \`<time>\${formatDue(task.due, now)}</time>\` : "";
  return \`<li class="card\${task.done ? " done" : ""}">\${escape(task.title)}\${due}</li>\`;
}

export function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
`,
      "src/render/board.js": `import { renderCard } from "./card.js";

export function renderBoard(list, now = Date.now()) {
  return \`<ul class="board">\${list.map((t) => renderCard(t, now)).join("")}</ul>\`;
}
`,
      "src/format.js": `const DAY = 24 * 60 * 60 * 1000;

export function formatDue(iso, now = Date.now()) {
  const days = Math.round((Date.parse(iso) - now) / DAY);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return days < 0 ? \`\${-days} days late\` : \`in \${days} days\`;
}
`,
      "src/theme.js": `export function resolveTheme(saved, systemDark) {
  if (saved === "light" || saved === "dark") return saved;
  return systemDark ? "dark" : "light";
}
`,
      "test/render.test.js": T(
        'import { renderBoard } from "../src/render/board.js";\nimport { escape } from "../src/render/card.js";',
        `test("renderBoard renders one card per task", () => {
  assert.equal((renderBoard([{ title: "a" }, { title: "b", done: true }]).match(/<li/g) || []).length, 2);
});
test("escape keeps markup out of titles", () => {
  assert.equal(escape("<b>"), "&lt;b&gt;");
});`,
      ),
      "test/format.test.js": T(
        'import { formatDue } from "../src/format.js";\nimport { resolveTheme } from "../src/theme.js";',
        `const now = Date.parse("2026-05-01T12:00:00Z");
test("formatDue reads relative days", () => {
  assert.equal(formatDue("2026-05-02T12:00:00Z", now), "tomorrow");
  assert.equal(formatDue("2026-04-28T12:00:00Z", now), "3 days late");
});
test("a saved theme wins over the system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme(null, true), "dark");
});`,
      ),
    },
  },
};

// ── scripted deliveries ─────────────────────────────────────────────────────
// A helper for the common shape: one new module and its test. `cost` is what the
// delivery reports; the screenshot world books it in the usage ledger like any call.
const mod = (file, src, testFile, testSrc, message, summary, cost = 0.62, turns = 14) => ({
  files: { [file]: src, [testFile]: testSrc },
  message,
  summary,
  cost,
  turns,
});

const testerOf = (slug, imports, body, summary, cost = 0.21) => ({
  files: { [`test/acceptance/${slug}.test.js`]: T(imports, body) },
  message: `test: black-box checks for ${slug.replace(/-/g, " ")}`,
  summary,
  cost,
  turns: 9,
});

// ── epics ───────────────────────────────────────────────────────────────────
// Each ticket: repo, title, description, acs (strings or {text, check_command}), risk,
// flow (what the screenshot script drives it to), steps (scripted deliveries), tester.
// Flows: done · done_rework (attempt 1 fails a gate) · done_tester_fail (tester FAIL
// first) · review · review_fix (the hero: comments + Fix these, back in review) ·
// testing (tester holds) · refining · blocked · ready_for_merge · ready · draft ·
// claimed (an agent holds it) · cancelled · regression (a bug linked to a done change).
export const EPICS = [
  {
    name: "Task lifecycle",
    description:
      "Create, complete, rename and close tasks in bulk, with the board grouping that goes with it.",
    tickets: [
      {
        key: "reopen",
        repo: "taskflow-core",
        title: "Reopen a completed task",
        description:
          "The inverse of completeTask in src/tasks.js: reopenTask(list, id) puts a task back to open and keeps its labels and due date.",
        acs: ["reopenTask sets done back to false and leaves every other field alone"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/reopen.js",
            "// Undo a completion: the task goes back to open with its fields intact.\nexport function reopenTask(list, id) {\n  return list.map((t) => (t.id === id ? { ...t, done: false } : t));\n}\n",
            "test/reopen.test.js",
            T(
              'import { reopenTask } from "../src/reopen.js";',
              'test("reopenTask reopens by id", () => {\n  const l = reopenTask([{ id: 1, done: true, labels: ["x"] }], 1);\n  assert.deepEqual(l[0], { id: 1, done: false, labels: ["x"] });\n});',
            ),
            "feat(tasks): reopenTask undoes a completion",
            "Added reopenTask in src/reopen.js with a test. Only the done flag changes.",
            0.31,
            8,
          ),
        ],
        tester: testerOf(
          "reopen-task",
          'import { reopenTask } from "../../src/reopen.js";',
          'test("a reopened task keeps its due date", () => {\n  assert.equal(reopenTask([{ id: 2, done: true, due: "2026-05-01" }], 2)[0].due, "2026-05-01");\n});',
          "Reopened tasks keep their due date and labels.",
          0.09,
        ),
      },
      {
        key: "bulk-archive",
        repo: "taskflow-core",
        title: "Archive every completed task",
        description:
          "Like groupByStatus in src/board.js, but for the Archive button: archiveDone(list) moves done tasks out of the list and returns { open, archived }.",
        acs: ["archiveDone splits the list into open and archived tasks, order kept"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/archive.js",
            "export function archiveDone(list) {\n  return { open: list.filter((t) => !t.done), archived: list.filter((t) => t.done) };\n}\n",
            "test/archive.test.js",
            T(
              'import { archiveDone } from "../src/archive.js";',
              'test("archiveDone splits by done", () => {\n  const r = archiveDone([{ id: 1, done: true }, { id: 2, done: false }]);\n  assert.deepEqual([r.open.length, r.archived.length], [1, 1]);\n});',
            ),
            "feat(tasks): archiveDone splits open and archived tasks",
            "Added archiveDone with a test; the board's Archive button can call it directly.",
            0.28,
            7,
          ),
        ],
        tester: testerOf(
          "archive-done",
          'import { archiveDone } from "../../src/archive.js";',
          'test("an empty list archives nothing", () => {\n  assert.deepEqual(archiveDone([]), { open: [], archived: [] });\n});',
          "Empty and mixed lists split as described.",
          0.08,
        ),
      },
      {
        key: "sort-by-due",
        repo: "taskflow-core",
        title: "Sort the board by due date",
        description:
          "sortByDue(list) puts the soonest due first and tasks with no date last, without mutating the input.",
        acs: ["Tasks sort soonest-due first, undated last", "The input list is not mutated"],
        risk: "medium",
        flow: "done_rework",
        steps: [
          {
            ...mod(
              "src/sort.js",
              "export function sortByDue(list) {\n  return list.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));\n}\n",
              "test/sort.test.js",
              T(
                'import { sortByDue } from "../src/sort.js";',
                'test("undated tasks sort last", () => {\n  const l = sortByDue([{ due: null }, { due: "2026-05-01" }]);\n  assert.equal(l[1].due, null);\n});',
              ),
              "feat(board): sortByDue",
              "Added sortByDue.",
              0.44,
              11,
            ),
          },
          {
            files: {
              "src/sort.js":
                "// Soonest due first; undated tasks last. Never mutates the input.\nexport function sortByDue(list) {\n  const key = (t) => (t.due ? Date.parse(t.due) : Infinity);\n  return [...list].sort((a, b) => key(a) - key(b));\n}\n",
            },
            message: "fix(board): undated tasks sort last and the input is copied",
            summary:
              "The tests gate caught undated tasks sorting first (NaN compare). sortByDue now keys undated tasks at Infinity and sorts a copy.",
            cost: 0.37,
            turns: 9,
          },
        ],
        tester: testerOf(
          "sort-by-due",
          'import { sortByDue } from "../../src/sort.js";',
          'test("the input order survives", () => {\n  const l = [{ due: "2026-06-01" }, { due: "2026-05-01" }];\n  sortByDue(l);\n  assert.equal(l[0].due, "2026-06-01");\n});',
          "Order and immutability both hold.",
          0.12,
        ),
      },
      {
        key: "group-by-label",
        repo: "taskflow-core",
        title: "Group the board by label",
        description:
          'byLabel in src/labels.js filters one label; groupByLabel(list) returns a Map of every label to its tasks, with unlabelled tasks under "(none)".',
        acs: [
          "groupByLabel groups by every label a task carries",
          "Unlabelled tasks are grouped under (none)",
        ],
        risk: "medium",
        flow: "done",
        steps: [
          mod(
            "src/group.js",
            'export function groupByLabel(list) {\n  const out = new Map();\n  for (const t of list)\n    for (const l of t.labels.length ? t.labels : ["(none)"]) out.set(l, [...(out.get(l) || []), t]);\n  return out;\n}\n',
            "test/group.test.js",
            T(
              'import { groupByLabel } from "../src/group.js";',
              'test("a task with two labels is in both groups", () => {\n  const g = groupByLabel([{ labels: ["a", "b"] }, { labels: [] }]);\n  assert.deepEqual([...g.keys()], ["a", "b", "(none)"]);\n});',
            ),
            "feat(board): groupByLabel",
            "Added groupByLabel with a test covering multi-label and unlabelled tasks.",
            0.58,
            13,
          ),
        ],
        tester: testerOf(
          "group-by-label",
          'import { groupByLabel } from "../../src/group.js";',
          'test("an empty list has no groups", () => {\n  assert.equal(groupByLabel([]).size, 0);\n});',
          "Both criteria hold, including the empty board.",
          0.14,
        ),
      },
      {
        key: "finish-skips-done",
        repo: "taskflow-core",
        title: "Finish all leaves completed tasks untouched",
        description:
          "completeTask() must skip done tasks, so Finish all (src/board.js) stops rewriting tasks that were already closed and their completed_at survives. Add completed_at when a task is closed.",
        acs: [
          {
            text: "completeTask() must skip done tasks and stamp completed_at on the ones it closes",
            check_command: "npm test",
          },
          "finishAll keeps the completed_at of tasks that were already done",
        ],
        risk: "medium",
        flow: "review_fix",
        steps: [
          {
            files: {
              "src/tasks.js": {
                replace: [
                  "return list.map((t) => (t.title === title ? { ...t, done: true } : t));",
                  "return list.map((t) =>\n    t.title === title && !t.done ? { ...t, done: true, completed_at: new Date().toISOString() } : t,\n  );",
                ],
              },
              "test/complete.test.js": T(
                'import { completeTask } from "../src/tasks.js";\nimport { finishAll } from "../src/board.js";',
                'test("completeTask stamps completed_at", () => {\n  assert.ok(completeTask([{ title: "a", done: false }], "a")[0].completed_at);\n});\ntest("finishAll keeps an earlier completed_at", () => {\n  const l = finishAll([{ title: "a", done: true, completed_at: "2026-01-01" }]);\n  assert.equal(l[0].completed_at, "2026-01-01");\n});',
              ),
            },
            message: "fix(tasks): completeTask skips done tasks and stamps completed_at",
            summary:
              "completeTask now skips tasks that are already done and stamps completed_at on the ones it closes, so finishAll no longer rewrites history. Two tests cover both criteria.",
            cost: 0.74,
            turns: 16,
          },
          {
            files: {
              "src/tasks.js": {
                replace: [
                  [
                    "t.title === title && !t.done ? { ...t, done: true, completed_at: new Date().toISOString() } : t,",
                    "t.title === title && !t.done ? { ...t, done: true, completed_at: stamp(now) } : t,",
                  ],
                  [
                    "export function completeTask(list, title) {",
                    "export function completeTask(list, title, now = Date.now()) {",
                  ],
                  [
                    "// Tasks are plain objects",
                    'import { stamp } from "./clock.js";\n\n// Tasks are plain objects',
                  ],
                ],
              },
              "src/clock.js":
                "// One place to read the clock, so tests can pin it.\nexport const stamp = (now = Date.now()) => new Date(now).toISOString();\n",
              "test/complete.test.js": {
                append:
                  'test("completeTask takes the clock it is given", () => {\n  assert.equal(completeTask([{ title: "a", done: false }], "a", 0)[0].completed_at, "1970-01-01T00:00:00.000Z");\n});\n',
              },
            },
            message: "refactor(tasks): completeTask takes the clock as a parameter",
            summary:
              "Addressed both review requirements: completeTask(list, title, now = Date.now()) reads the clock through src/clock.js, and a test pins it.",
            cost: 0.41,
            turns: 10,
          },
        ],
        // The review comments the person leaves on the first delivery (the hero).
        comments: [
          {
            path: "src/tasks.js",
            match: "completed_at: new Date().toISOString()",
            severity: "must_fix",
            body: "Take the clock as a parameter (now = Date.now()) so the tests can pin it.",
          },
          {
            path: "test/complete.test.js",
            match: "finishAll keeps an earlier completed_at",
            severity: "consider",
            body: "A case with a mix of open and done tasks would show the skip more clearly.",
          },
        ],
        contract: {
          changed_surfaces: [
            "Completing a task records when it was closed",
            "Finish all on the board leaves tasks that were already done as they were",
            "the taskflow count and overdue commands",
          ],
          runtime_deps: ["node 22"],
          env_vars: [],
          run_command: "npm test",
          harness_ready: true,
        },
        profile: {
          profile: "cli",
          spec: {
            cases: [
              {
                name: "open tasks after finishing",
                argv: ["node", "bin/taskflow.js", "count", "--file", "test/fixtures/tasks.json"],
                expect: { exit: 0, stdout: ["open: 2"] },
              },
              {
                name: "overdue list",
                argv: ["node", "bin/taskflow.js", "overdue", "--file", "test/fixtures/tasks.json"],
                expect: { exit: 0, stdout: ["Renew the domain"] },
              },
            ],
          },
        },
        tester: testerOf(
          "finish-all",
          'import { finishAll } from "../../src/board.js";',
          'test("finishAll closes open tasks and leaves closed ones", () => {\n  const l = finishAll([{ title: "a", done: true, completed_at: "x" }, { title: "b", done: false }]);\n  assert.equal(l[0].completed_at, "x");\n  assert.equal(l[1].done, true);\n});',
          "Both criteria hold from the outside: Finish all closes open tasks and leaves the completed_at of closed ones alone.",
          0.19,
        ),
      },
    ],
  },
  {
    name: "Due dates and reminders",
    description:
      "Due dates on every surface, the morning digest and reminders before a task is due.",
    tickets: [
      {
        key: "due-tomorrow",
        repo: "taskflow-core",
        title: "List tasks due tomorrow",
        description:
          "Next to dueWithin in src/due.js: dueTomorrow(list, now) lists open tasks whose due date falls on the next calendar day (UTC).",
        acs: ["dueTomorrow returns only open tasks due on the next UTC day"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/tomorrow.js",
            "export function dueTomorrow(list, now = Date.now()) {\n  const d = new Date(now + 86400000).toISOString().slice(0, 10);\n  return list.filter((t) => !t.done && t.due && t.due.slice(0, 10) === d);\n}\n",
            "test/tomorrow.test.js",
            T(
              'import { dueTomorrow } from "../src/tomorrow.js";',
              'test("dueTomorrow keeps the next day only", () => {\n  const now = Date.parse("2026-05-01T10:00:00Z");\n  const l = [{ done: false, due: "2026-05-02" }, { done: false, due: "2026-05-03" }];\n  assert.equal(dueTomorrow(l, now).length, 1);\n});',
            ),
            "feat(due): dueTomorrow",
            "Added dueTomorrow with a test.",
            0.26,
            7,
          ),
        ],
        tester: testerOf(
          "due-tomorrow",
          'import { dueTomorrow } from "../../src/tomorrow.js";',
          'test("done tasks are never due", () => {\n  assert.equal(dueTomorrow([{ done: true, due: "2026-05-02" }], Date.parse("2026-05-01")).length, 0);\n});',
          "Closed tasks are left out; the next-day window holds.",
          0.07,
        ),
      },
      {
        key: "digest-subject",
        repo: "taskflow-core",
        title: "Digest subject line counts what is due",
        description:
          'The morning email reuses digestLines from src/digest.js; digestSubject(list, now) gives it a subject: "3 tasks due soon", or "Nothing due".',
        acs: ["The subject counts tasks due in two days and reads Nothing due when there are none"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/subject.js",
            'import { dueWithin } from "./due.js";\n\nexport function digestSubject(list, now = Date.now()) {\n  const n = dueWithin(list, 2, now).length;\n  return n ? `${n} task${n === 1 ? "" : "s"} due soon` : "Nothing due";\n}\n',
            "test/subject.test.js",
            T(
              'import { digestSubject } from "../src/subject.js";',
              'test("digestSubject counts", () => {\n  assert.equal(digestSubject([]), "Nothing due");\n});',
            ),
            "feat(digest): subject line counts what is due",
            "Added digestSubject on top of dueWithin, with a test for the empty case.",
            0.24,
            6,
          ),
        ],
        tester: testerOf(
          "digest-subject",
          'import { digestSubject } from "../../src/subject.js";',
          'test("one task reads singular", () => {\n  const now = Date.parse("2026-05-01T00:00:00Z");\n  assert.equal(digestSubject([{ done: false, due: "2026-05-02T00:00:00Z" }], now), "1 task due soon");\n});',
          "Singular, plural and empty subjects all read right.",
          0.08,
        ),
      },
      {
        key: "overdue-endpoint",
        repo: "taskflow-api",
        title: "GET /tasks?overdue=1 lists overdue tasks",
        description:
          "listTasks in src/routes/tasks.js takes overdue=1 and returns open tasks whose due date has passed, oldest first.",
        acs: [
          "GET /tasks?overdue=1 returns only open overdue tasks",
          "Results are ordered oldest due first",
        ],
        risk: "medium",
        flow: "done_tester_fail",
        steps: [
          mod(
            "src/routes/overdue.js",
            "export function overdueTasks(store, now = Date.now()) {\n  return store\n    .list()\n    .filter((t) => !t.done && t.due && Date.parse(t.due) < now)\n    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));\n}\n",
            "test/overdue.test.js",
            T(
              'import { overdueTasks } from "../src/routes/overdue.js";\nimport { createStore } from "../src/store.js";',
              'test("overdueTasks sorts oldest first", () => {\n  const s = createStore([{ done: false, due: "2026-02-01" }, { done: false, due: "2026-01-01" }]);\n  assert.equal(overdueTasks(s, Date.parse("2026-03-01"))[0].due, "2026-01-01");\n});',
            ),
            "feat(api): overdue tasks route",
            "Added overdueTasks behind GET /tasks?overdue=1, oldest first.",
            0.67,
            15,
          ),
          {
            files: {
              "src/routes/overdue.js": {
                append:
                  "\n// Closed tasks are never overdue, whatever their date (tester observation on attempt 1).\n",
              },
            },
            message: "docs(api): note that closed tasks are never overdue",
            summary: "Addressed the tester's observation and noted the rule beside the filter.",
            cost: 0.22,
            turns: 6,
          },
        ],
        tester: testerOf(
          "overdue-route",
          'import { overdueTasks } from "../../src/routes/overdue.js";\nimport { createStore } from "../../src/store.js";',
          'test("closed tasks are never overdue", () => {\n  assert.equal(overdueTasks(createStore([{ done: true, due: "2020-01-01" }])).length, 0);\n});',
          "Overdue filtering and ordering hold from the outside.",
          0.18,
        ),
      },
      {
        key: "reminder-window",
        repo: "taskflow-core",
        title: "Reminders an hour before a task is due",
        description:
          "Built on the due dates in src/due.js: remindersDue(list, now) returns open tasks due within the next hour that have not been reminded yet.",
        acs: ["Tasks due within the hour are returned once", "Tasks already reminded are skipped"],
        risk: "medium",
        flow: "done",
        steps: [
          mod(
            "src/remind.js",
            "const HOUR = 3600000;\n\nexport function remindersDue(list, now = Date.now()) {\n  return list.filter((t) => !t.done && !t.reminded && t.due && Date.parse(t.due) - now <= HOUR && Date.parse(t.due) > now);\n}\n",
            "test/remind.test.js",
            T(
              'import { remindersDue } from "../src/remind.js";',
              'test("remindersDue skips reminded tasks", () => {\n  const now = Date.parse("2026-05-01T10:00:00Z");\n  const l = [{ done: false, due: "2026-05-01T10:30:00Z" }, { done: false, reminded: true, due: "2026-05-01T10:30:00Z" }];\n  assert.equal(remindersDue(l, now).length, 1);\n});',
            ),
            "feat(reminders): remindersDue for the hour ahead",
            "Added remindersDue with a test for the reminded flag.",
            0.55,
            12,
          ),
        ],
        tester: testerOf(
          "reminders",
          'import { remindersDue } from "../../src/remind.js";',
          'test("a task already past due gets no reminder", () => {\n  const now = Date.parse("2026-05-01T10:00:00Z");\n  assert.equal(remindersDue([{ done: false, due: "2026-05-01T09:00:00Z" }], now).length, 0);\n});',
          "The window and the reminded flag both hold.",
          0.13,
        ),
      },
      {
        key: "due-badge",
        repo: "taskflow-web",
        title: "Show a late badge on overdue cards",
        description:
          'renderCard in src/render/card.js shows the due date; a card whose date has passed gets a "late" badge beside it, and done cards never do.',
        acs: ["Overdue open cards render a late badge", "Done cards never render the badge"],
        risk: "medium",
        flow: "done",
        steps: [
          mod(
            "src/render/badge.js",
            'export function lateBadge(task, now = Date.now()) {\n  return !task.done && task.due && Date.parse(task.due) < now ? \'<span class="badge late">late</span>\' : "";\n}\n',
            "test/badge.test.js",
            T(
              'import { lateBadge } from "../src/render/badge.js";',
              'test("done cards get no badge", () => {\n  assert.equal(lateBadge({ done: true, due: "2020-01-01" }), "");\n});\ntest("late cards get one", () => {\n  assert.match(lateBadge({ done: false, due: "2020-01-01" }), /late/);\n});',
            ),
            "feat(board): late badge on overdue cards",
            "Added lateBadge with tests for both criteria.",
            0.49,
            12,
          ),
        ],
        tester: testerOf(
          "late-badge",
          'import { lateBadge } from "../../src/render/badge.js";',
          'test("an undated card has no badge", () => {\n  assert.equal(lateBadge({ done: false, due: null }), "");\n});',
          "Badge rules hold, including undated cards.",
          0.11,
        ),
      },
      {
        key: "digest-timezone",
        repo: "taskflow-core",
        title: "Send the digest at 08:00 in the user's timezone",
        description:
          "nextDigestAt(now, tz) returns the next 08:00 wall-clock time in the given IANA timezone.",
        acs: [
          "nextDigestAt returns today's 08:00 before it, tomorrow's after it",
          "The time is computed in the user's timezone",
        ],
        risk: "medium",
        flow: "testing",
        steps: [
          mod(
            "src/schedule.js",
            'export function nextDigestAt(now, tz) {\n  const local = new Date(new Date(now).toLocaleString("en-US", { timeZone: tz }));\n  const next = new Date(local);\n  next.setHours(8, 0, 0, 0);\n  if (next <= local) next.setDate(next.getDate() + 1);\n  return new Date(now + (next - local));\n}\n',
            "test/schedule.test.js",
            T(
              'import { nextDigestAt } from "../src/schedule.js";',
              'test("nextDigestAt is in the future", () => {\n  const now = Date.now();\n  assert.ok(nextDigestAt(now, "Europe/London") > new Date(now));\n});',
            ),
            "feat(digest): schedule the digest at 08:00 local time",
            "Added nextDigestAt with a test.",
            0.58,
            13,
          ),
        ],
      },
      {
        key: "snooze",
        repo: "taskflow-core",
        title: "Snooze a reminder for a day",
        description:
          "snooze(task, days, now) pushes the due date forward and clears the reminded flag.",
        acs: ["snooze moves the due date by whole days", "snooze clears the reminded flag"],
        risk: "medium",
        flow: "done_reviewed",
        steps: [
          mod(
            "src/snooze.js",
            "const DAY = 86400000;\n\nexport function snooze(task, days = 1) {\n  const due = new Date(Date.parse(task.due) + days * DAY).toISOString();\n  return { ...task, due, reminded: false };\n}\n",
            "test/snooze.test.js",
            T(
              'import { snooze } from "../src/snooze.js";',
              'test("snooze moves the date and clears reminded", () => {\n  const t = snooze({ due: "2026-05-01T09:00:00.000Z", reminded: true }, 2);\n  assert.deepEqual(t, { due: "2026-05-03T09:00:00.000Z", reminded: false });\n});',
            ),
            "feat(reminders): snooze a task by whole days",
            "Added snooze(task, days) with a test covering both criteria.",
            0.48,
            11,
          ),
        ],
        tester: testerOf(
          "snooze",
          'import { snooze } from "../../src/snooze.js";',
          'test("the default snooze is one day", () => {\n  assert.equal(snooze({ due: "2026-05-01T00:00:00.000Z" }).due, "2026-05-02T00:00:00.000Z");\n});',
          "Snoozing moves the date by whole days and clears the reminder.",
          0.1,
        ),
      },
    ],
  },
  {
    name: "Session auth",
    description:
      "Signed sessions for the API: issue, refresh, revoke, and the per-token rate limit that sits in front.",
    tickets: [
      {
        key: "session-expiry",
        repo: "taskflow-api",
        title: "Expire sessions after 14 days",
        description:
          "verifySession refuses a session token older than 14 days. The issue time is already in the signed payload.",
        acs: [
          "A session token older than 14 days no longer verifies",
          "A fresh session token still verifies",
        ],
        risk: "high",
        flow: "ready",
        steps: [
          {
            files: {
              "src/auth/expiry.js":
                'const MAX_AGE = 14 * 24 * 60 * 60 * 1000;\n\n// The issue time is the second field of the signed payload (user.issuedAt.sig).\nexport function isExpired(token, now = Date.now()) {\n  const issued = Number(token.split(".")[1]);\n  return !Number.isFinite(issued) || now - issued > MAX_AGE;\n}\n',
              "test/expiry.test.js": T(
                'import { isExpired } from "../src/auth/expiry.js";\nimport { issueSession } from "../src/auth/session.js";',
                'test("a 15-day-old session token is expired", () => {\n  const tok = issueSession("ana", "s", 0);\n  assert.equal(isExpired(tok, 15 * 86400000), true);\n});\ntest("a fresh one is not", () => {\n  assert.equal(isExpired(issueSession("ana", "s"), Date.now()), false);\n});',
              ),
            },
            message: "feat(auth): session tokens expire after 14 days",
            summary:
              "Added isExpired over the signed issue time and tests for both criteria. verifySession callers check it next.",
            cost: 1.12,
            turns: 21,
          },
        ],
        tester: testerOf(
          "session-expiry",
          'import { isExpired } from "../../src/auth/expiry.js";',
          'test("a malformed token counts as expired", () => {\n  assert.equal(isExpired("nonsense"), true);\n});',
          "Old, fresh and malformed session tokens behave as the criteria say.",
          0.24,
        ),
      },
      {
        key: "rate-limit",
        repo: "taskflow-api",
        title: "Rate-limit each API token to 100 requests a minute",
        description:
          "A sliding-window limiter keyed by API token. Over the limit, answer 429 with Retry-After. Bursts arrive as concurrent requests, so the window update must not race.",
        acs: [
          "The 101st request inside a minute is refused with 429",
          "Retry-After says how many seconds until the window frees up",
        ],
        risk: "low",
        flow: "review",
        steps: [
          mod(
            "src/ratelimit.js",
            "export function createLimiter(limit = 100, windowMs = 60000) {\n  const hits = new Map();\n  return (key, now = Date.now()) => {\n    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);\n    if (recent.length >= limit) return { ok: false, retryAfter: Math.ceil((windowMs - (now - recent[0])) / 1000) };\n    hits.set(key, [...recent, now]);\n    return { ok: true };\n  };\n}\n",
            "test/ratelimit.test.js",
            T(
              'import { createLimiter } from "../src/ratelimit.js";',
              'test("the 101st hit is refused", () => {\n  const hit = createLimiter();\n  for (let i = 0; i < 100; i++) assert.equal(hit("k", 0).ok, true);\n  const r = hit("k", 1000);\n  assert.deepEqual(r, { ok: false, retryAfter: 59 });\n});',
            ),
            "feat(api): sliding-window rate limit per token",
            "Added createLimiter (sliding window, per key) with a test for the 101st request and Retry-After.",
            0.81,
            17,
          ),
        ],
        tester: testerOf(
          "rate-limit",
          'import { createLimiter } from "../../src/ratelimit.js";',
          'test("keys are limited separately", () => {\n  const hit = createLimiter(1);\n  assert.equal(hit("a", 0).ok, true);\n  assert.equal(hit("b", 0).ok, true);\n});',
          "Per-token limits and Retry-After hold.",
          0.16,
        ),
      },
      {
        key: "session-refresh",
        repo: "taskflow-api",
        title: "Refresh a session token before it expires",
        description:
          "POST /session/refresh swaps a valid session token for a new one with a fresh issue time; an expired one is refused.",
        acs: [
          "A valid session token is swapped for a new one",
          "An expired session token is refused with 401",
        ],
        risk: "medium",
        flow: "claimed",
      },
      {
        key: "revoke-sessions",
        repo: "taskflow-api",
        title: "Sign out everywhere",
        description:
          "Revoke every session for a user by bumping a per-user generation that the signed payload carries.",
        acs: ["After sign out everywhere, older session tokens no longer verify"],
        risk: "medium",
        flow: "draft",
      },
    ],
  },
  {
    name: "Board polish",
    description: "The web board: cards, themes, keyboard use and the small things people notice.",
    tickets: [
      {
        key: "dark-theme",
        repo: "taskflow-web",
        title: "Remember the chosen theme",
        description:
          "resolveTheme in src/theme.js already prefers a saved theme; read it from storage so a returning user gets the theme they picked.",
        acs: ["A saved theme wins over the system preference"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/prefs.js",
            'import { resolveTheme } from "./theme.js";\n\nexport function themeFor(storage, systemDark) {\n  return resolveTheme(storage.get("theme"), systemDark);\n}\n',
            "test/prefs.test.js",
            T(
              'import { themeFor } from "../src/prefs.js";',
              'test("a stored theme wins", () => {\n  assert.equal(themeFor(new Map([["theme", "light"]]), true), "light");\n});',
            ),
            "feat(theme): remember the chosen theme",
            "themeFor reads the saved theme and falls back to the system one.",
            0.22,
            6,
          ),
        ],
        tester: testerOf(
          "theme-pref",
          'import { themeFor } from "../../src/prefs.js";',
          'test("no saved theme follows the system", () => {\n  assert.equal(themeFor(new Map(), false), "light");\n});',
          "Saved and unsaved themes both resolve as described.",
          0.06,
        ),
      },
      {
        key: "card-labels",
        repo: "taskflow-web",
        title: "Show labels on board cards",
        description:
          "renderCard in src/render/card.js lists the labels as chips after the title, through escape().",
        acs: ["Labels render as escaped chips on the card"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/render/chips.js",
            'import { escape } from "./card.js";\n\nexport function labelChips(labels = []) {\n  return labels.map((l) => `<span class="chip">${escape(l)}</span>`).join("");\n}\n',
            "test/chips.test.js",
            T(
              'import { labelChips } from "../src/render/chips.js";',
              'test("chips are escaped", () => {\n  assert.equal(labelChips(["<x>"]), \'<span class="chip">&lt;x&gt;</span>\');\n});',
            ),
            "feat(board): label chips on cards",
            "Added labelChips with an escaping test.",
            0.27,
            7,
          ),
        ],
        tester: testerOf(
          "label-chips",
          'import { labelChips } from "../../src/render/chips.js";',
          'test("no labels, no chips", () => {\n  assert.equal(labelChips(), "");\n});',
          "Chips render escaped; none when there are no labels.",
          0.07,
        ),
      },
      {
        key: "relative-dates",
        repo: "taskflow-web",
        title: 'Say "yesterday" for tasks one day late',
        description:
          'formatDue in src/format.js says "1 days late"; a task one day late should read "yesterday".',
        acs: ["A task one day late reads yesterday"],
        risk: "low",
        flow: "done",
        steps: [
          mod(
            "src/relative.js",
            'import { formatDue } from "./format.js";\n\nconst DAY = 86400000;\nexport function relativeDue(iso, now = Date.now()) {\n  return Math.round((Date.parse(iso) - now) / DAY) === -1 ? "yesterday" : formatDue(iso, now);\n}\n',
            "test/relative.test.js",
            T(
              'import { relativeDue } from "../src/relative.js";',
              'test("one day late reads yesterday", () => {\n  const now = Date.parse("2026-05-02T12:00:00Z");\n  assert.equal(relativeDue("2026-05-01T12:00:00Z", now), "yesterday");\n});',
            ),
            "fix(board): one day late reads yesterday",
            "Wrapped formatDue so a task one day late reads yesterday.",
            0.19,
            5,
          ),
        ],
        tester: testerOf(
          "relative-dates",
          'import { relativeDue } from "../../src/relative.js";',
          'test("two days late is unchanged", () => {\n  const now = Date.parse("2026-05-03T12:00:00Z");\n  assert.equal(relativeDue("2026-05-01T12:00:00Z", now), "2 days late");\n});',
          "Yesterday and the other cases read correctly.",
          0.05,
        ),
      },
      {
        key: "keyboard-complete",
        repo: "taskflow-web",
        title: "Complete the focused card with the x key",
        description: "A keydown handler on the board: x completes the focused card, u reopens it.",
        acs: ["x completes the focused card", "u reopens it"],
        risk: "medium",
        flow: "refining",
        steps: [
          mod(
            "src/keys.js",
            'export function onKey(key, focused) {\n  if (key === "x") return { action: "complete", id: focused };\n  if (key === "u") return { action: "reopen", id: focused };\n  return null;\n}\n',
            "test/keys.test.js",
            T(
              'import { onKey } from "../src/keys.js";',
              'test("x completes", () => {\n  assert.deepEqual(onKey("x", 3), { action: "complete", id: 3 });\n});',
            ),
            "feat(board): x and u keys on the focused card",
            "Added onKey for x and u.",
            0.46,
            11,
          ),
        ],
      },
      {
        key: "empty-board",
        repo: "taskflow-web",
        title: "Friendly empty board",
        description:
          'An empty board says "Nothing on the board. Add a task to get started." instead of an empty list.',
        acs: ["An empty board renders the friendly line"],
        risk: "low",
        flow: "ready_for_merge",
        steps: [
          mod(
            "src/render/empty.js",
            'import { renderBoard } from "./board.js";\n\nexport function renderBoardOrEmpty(list, now) {\n  return list.length ? renderBoard(list, now) : \'<p class="empty">Nothing on the board. Add a task to get started.</p>\';\n}\n',
            "test/empty.test.js",
            T(
              'import { renderBoardOrEmpty } from "../src/render/empty.js";',
              'test("the empty board says so", () => {\n  assert.match(renderBoardOrEmpty([]), /Nothing on the board/);\n});',
            ),
            "feat(board): friendly empty board",
            "Added renderBoardOrEmpty with a test.",
            0.21,
            6,
          ),
        ],
        tester: testerOf(
          "empty-board",
          'import { renderBoardOrEmpty } from "../../src/render/empty.js";',
          'test("a board with tasks renders them", () => {\n  assert.match(renderBoardOrEmpty([{ title: "a" }]), /<ul/);\n});',
          "Empty and populated boards both render.",
          0.06,
        ),
      },
      {
        key: "drag-reorder",
        repo: "taskflow-web",
        title: "Drag cards to reorder a column",
        description:
          "Reorder cards within a column by drag and drop; the order is saved per column.",
        acs: ["Dropping a card saves the new order", "The order survives a reload"],
        risk: "medium",
        flow: "draft",
      },
    ],
  },
  {
    name: "Recurring tasks",
    description:
      "Tasks that repeat daily, weekly or monthly, generated from a rule when the last one is closed.",
    tickets: [
      {
        key: "recurrence-rule",
        repo: "taskflow-core",
        title: "Parse a recurrence rule",
        description:
          'parseRule("weekly on mon,thu") returns { freq, days } and refuses rules it cannot read.',
        acs: [
          "daily, weekly and monthly rules parse",
          "An unreadable rule is refused with the reason",
        ],
        risk: "medium",
        flow: "ready",
      },
      {
        key: "next-occurrence",
        repo: "taskflow-core",
        title: "Generate the next occurrence when a recurring task closes",
        description:
          "Closing a recurring task adds the next one with the same title and labels and the next due date from its rule.",
        acs: [
          "Closing a recurring task adds exactly one next occurrence",
          "No duplicate occurrence for the same due date",
        ],
        risk: "medium",
        flow: "draft",
        dependsOn: ["recurrence-rule"],
      },
      {
        key: "recurring-badge",
        repo: "taskflow-web",
        title: "Recurring badge on cards",
        description:
          "Cards of recurring tasks show a small repeat badge with the rule as its title.",
        acs: ["Recurring cards show the repeat badge"],
        risk: "low",
        flow: "draft",
        dependsOn: ["recurrence-rule"],
      },
    ],
  },
];

// ── tickets outside any epic ────────────────────────────────────────────────
export const LOOSE = [
  {
    key: "label-rename",
    repo: "taskflow-core",
    title: "Rename a label across every task",
    description:
      "Next to addLabel in src/labels.js: renameLabel(list, from, to) renames a label on every task that carries it, without duplicating it.",
    acs: [
      "renameLabel renames on every task that carries the label",
      "A task never ends up with the same label twice",
    ],
    risk: "medium",
    flow: "done",
    steps: [
      mod(
        "src/rename-label.js",
        "export function renameLabel(list, from, to) {\n  return list.map((t) => ({ ...t, labels: [...new Set(t.labels.map((l) => (l === from ? to : l)))] }));\n}\n",
        "test/rename-label.test.js",
        T(
          'import { renameLabel } from "../src/rename-label.js";',
          'test("no duplicate after a rename", () => {\n  assert.deepEqual(renameLabel([{ labels: ["a", "b"] }], "a", "b")[0].labels, ["b"]);\n});',
        ),
        "feat(labels): renameLabel",
        "Added renameLabel with a duplicate test.",
        0.23,
        6,
      ),
    ],
    tester: testerOf(
      "rename-label",
      'import { renameLabel } from "../../src/rename-label.js";',
      'test("other labels are untouched", () => {\n  assert.deepEqual(renameLabel([{ labels: ["c"] }], "a", "b")[0].labels, ["c"]);\n});',
      "Renames hold and nothing else changes.",
      0.06,
    ),
  },
  {
    key: "empty-title",
    repo: "taskflow-core",
    title: "renameTask refuses an empty title",
    description:
      "renameTask in src/tasks.js accepts a blank title; keep the old title when the new one is blank.",
    acs: ["A blank title leaves the task unchanged"],
    risk: "low",
    flow: "done",
    steps: [
      mod(
        "src/rename.js",
        'import { renameTask } from "./tasks.js";\n\nexport function safeRename(list, id, title) {\n  return String(title || "").trim() ? renameTask(list, id, title.trim()) : list;\n}\n',
        "test/rename.test.js",
        T(
          'import { safeRename } from "../src/rename.js";',
          'test("a blank title is ignored", () => {\n  const l = [{ id: 1, title: "a" }];\n  assert.equal(safeRename(l, 1, "  "), l);\n});',
        ),
        "fix(tasks): ignore blank titles on rename",
        "Added safeRename over renameTask with a test.",
        0.17,
        5,
      ),
    ],
    tester: testerOf(
      "safe-rename",
      'import { safeRename } from "../../src/rename.js";',
      'test("a real title still renames", () => {\n  assert.equal(safeRename([{ id: 1, title: "a" }], 1, " b ")[0].title, "b");\n});',
      "Blank titles are ignored and real ones trimmed.",
      0.04,
    ),
  },
  {
    key: "escape-closes",
    repo: "taskflow-web",
    title: "Escape closes the task drawer",
    description:
      "Pressing Escape while the task drawer is open closes it and returns focus to the card.",
    acs: ["Escape closes the drawer and focus returns to the card"],
    risk: "low",
    flow: "done",
    steps: [
      mod(
        "src/drawer.js",
        'export function drawerKey(key, state) {\n  return key === "Escape" && state.open ? { open: false, focus: state.card } : state;\n}\n',
        "test/drawer.test.js",
        T(
          'import { drawerKey } from "../src/drawer.js";',
          'test("Escape closes and refocuses", () => {\n  assert.deepEqual(drawerKey("Escape", { open: true, card: 4 }), { open: false, focus: 4 });\n});',
        ),
        "feat(board): Escape closes the task drawer",
        "Added drawerKey with a test.",
        0.16,
        5,
      ),
    ],
    tester: testerOf(
      "drawer-escape",
      'import { drawerKey } from "../../src/drawer.js";',
      'test("other keys leave it open", () => {\n  assert.equal(drawerKey("a", { open: true, card: 1 }).open, true);\n});',
      "Escape closes; other keys do nothing.",
      0.04,
    ),
  },
  {
    key: "count-cli",
    repo: "taskflow-core",
    title: "taskflow count --label filters by label",
    description:
      "The taskflow count command takes --label and counts only open tasks with that label.",
    acs: ["taskflow count --label team counts open tasks labelled team"],
    risk: "low",
    flow: "done",
    steps: [
      mod(
        "src/count.js",
        "export function countOpen(list, label) {\n  return list.filter((t) => !t.done && (!label || t.labels.includes(label))).length;\n}\n",
        "test/count.test.js",
        T(
          'import { countOpen } from "../src/count.js";',
          'test("countOpen filters by label", () => {\n  assert.equal(countOpen([{ done: false, labels: ["team"] }, { done: false, labels: [] }], "team"), 1);\n});',
        ),
        "feat(cli): count --label",
        "Added countOpen for the count command's --label flag.",
        0.21,
        6,
      ),
    ],
    tester: testerOf(
      "count-label",
      'import { countOpen } from "../../src/count.js";',
      'test("no label counts every open task", () => {\n  assert.equal(countOpen([{ done: false, labels: [] }, { done: true, labels: [] }]), 1);\n});',
      "Counting with and without a label holds.",
      0.05,
    ),
  },
  {
    key: "trim-titles",
    repo: "taskflow-api",
    title: "Trim whitespace from task titles",
    description:
      "createTask in src/routes/tasks.js trims leading and trailing whitespace and collapses runs of spaces in the title.",
    acs: ["Titles are trimmed and inner runs of spaces collapsed"],
    risk: "low",
    flow: "done",
    steps: [
      mod(
        "src/clean.js",
        'export function cleanTitle(s) {\n  return String(s).trim().replace(/\\s+/g, " ");\n}\n',
        "test/clean.test.js",
        T(
          'import { cleanTitle } from "../src/clean.js";',
          'test("cleanTitle collapses spaces", () => {\n  assert.equal(cleanTitle("  a   b "), "a b");\n});',
        ),
        "fix(api): trim task titles",
        "Added cleanTitle for the create route.",
        0.18,
        5,
      ),
    ],
    tester: testerOf(
      "clean-title",
      'import { cleanTitle } from "../../src/clean.js";',
      'test("tabs collapse too", () => {\n  assert.equal(cleanTitle("a\\t\\tb"), "a b");\n});',
      "Whitespace handling holds for spaces and tabs.",
      0.05,
    ),
  },
  {
    key: "health-route",
    repo: "taskflow-api",
    title: "GET /healthz for the load balancer",
    description: "A GET /healthz route that answers 200 {ok:true} without touching the store.",
    acs: ["GET /healthz answers 200 with ok true"],
    risk: "low",
    flow: "done",
    steps: [
      mod(
        "src/health.js",
        "export function healthz() {\n  return { status: 200, body: { ok: true } };\n}\n",
        "test/health.test.js",
        T(
          'import { healthz } from "../src/health.js";',
          'test("healthz is ok", () => {\n  assert.deepEqual(healthz(), { status: 200, body: { ok: true } });\n});',
        ),
        "feat(api): /healthz",
        "Added healthz with a test.",
        0.14,
        4,
      ),
    ],
    tester: testerOf(
      "healthz",
      'import { healthz } from "../../src/health.js";',
      'test("healthz needs no store", () => {\n  assert.equal(healthz().status, 200);\n});',
      "The route answers without a store.",
      0.04,
    ),
  },
  {
    key: "page-size",
    repo: "taskflow-api",
    title: "Cap GET /tasks at 200 rows a page",
    description:
      "listTasks in src/routes/tasks.js returns every row; take limit (default 50, max 200) and offset, and say the next offset.",
    acs: [
      "limit defaults to 50 and is capped at 200",
      "The answer says the next offset, or null on the last page",
    ],
    risk: "medium",
    flow: "done",
    steps: [
      mod(
        "src/page.js",
        "export function page(list, limit = 50, offset = 0) {\n  const n = Math.min(Math.max(1, limit), 200);\n  const rows = list.slice(offset, offset + n);\n  return { rows, next: offset + n < list.length ? offset + n : null };\n}\n",
        "test/page.test.js",
        T(
          'import { page } from "../src/page.js";',
          'test("limit is capped", () => {\n  assert.equal(page(Array(500).fill(0), 1000).rows.length, 200);\n});',
        ),
        "feat(api): paginate GET /tasks",
        "Added page() with the 200-row cap.",
        0.25,
        7,
      ),
    ],
    tester: testerOf(
      "page-size",
      'import { page } from "../../src/page.js";',
      'test("the last page has no next", () => {\n  assert.equal(page([1, 2], 50).next, null);\n});',
      "The cap and the next offset hold.",
      0.06,
    ),
  },
  {
    key: "export-csv",
    repo: "taskflow-api",
    title: "Export tasks as CSV",
    description:
      "GET /tasks.csv returns the visible columns as CSV, quoting titles that contain commas or quotes.",
    acs: [
      "The header row lists id, title and done",
      "Titles with commas or quotes are quoted correctly",
    ],
    risk: "medium",
    flow: "done",
    steps: [
      mod(
        "src/csv.js",
        'const q = (s) => (/[",\\n]/.test(s) ? `"${String(s).replace(/"/g, \'""\')}"` : String(s));\nexport function toCsv(list) {\n  return ["id,title,done", ...list.map((t) => [t.id, q(t.title), t.done].join(","))].join("\\n");\n}\n',
        "test/csv.test.js",
        T(
          'import { toCsv } from "../src/csv.js";',
          'test("commas are quoted", () => {\n  assert.equal(toCsv([{ id: 1, title: "a,b", done: false }]).split("\\n")[1], \'1,"a,b",false\');\n});',
        ),
        "feat(api): tasks as CSV",
        "Added toCsv with quoting tests.",
        0.29,
        8,
      ),
    ],
    tester: testerOf(
      "csv-export",
      'import { toCsv } from "../../src/csv.js";',
      'test("quotes are doubled", () => {\n  assert.equal(toCsv([{ id: 1, title: \'say "hi"\', done: true }]).split("\\n")[1], \'1,"say ""hi""",true\');\n});',
      "Quoting holds for commas and quotes.",
      0.07,
    ),
  },
  {
    key: "digest-escapes",
    repo: "taskflow-core",
    title: "Digest lines break on titles with a newline",
    description:
      "A task title with a newline splits the digest line in two. Reported after the digest subject change landed: fold newlines into spaces in digestLines.",
    acs: ["A title with a newline stays on one digest line"],
    risk: "low",
    flow: "regression",
    regressionOf: "digest-subject",
    steps: [
      mod(
        "src/fold.js",
        'export const fold = (s) => String(s).replace(/\\s*\\n\\s*/g, " ");\n',
        "test/fold.test.js",
        T(
          'import { fold } from "../src/fold.js";',
          'test("fold joins lines", () => {\n  assert.equal(fold("a\\n b"), "a b");\n});',
        ),
        "fix(digest): fold newlines in titles",
        "Added fold() for digest titles with a test.",
        0.2,
        6,
      ),
    ],
    tester: testerOf(
      "fold-titles",
      'import { fold } from "../../src/fold.js";',
      'test("a plain title is unchanged", () => {\n  assert.equal(fold("Ship it"), "Ship it");\n});',
      "Titles with and without newlines read on one line.",
      0.05,
    ),
  },
  {
    key: "etag",
    repo: "taskflow-api",
    title: "ETag on GET /tasks",
    description:
      "The GET /tasks route in src/server.js answers with a weak ETag over the list and 304 when If-None-Match matches.",
    acs: [
      "GET /tasks carries an ETag that changes when the list changes",
      "A matching If-None-Match answers 304 with no body",
    ],
    risk: "medium",
    flow: "done",
    steps: [
      mod(
        "src/etag.js",
        'import { createHash } from "node:crypto";\n\nexport function etagOf(list) {\n  return `W/"${createHash("sha1").update(JSON.stringify(list)).digest("hex").slice(0, 16)}"`;\n}\n\nexport function conditional(list, ifNoneMatch) {\n  const tag = etagOf(list);\n  return ifNoneMatch === tag ? { status: 304, tag } : { status: 200, tag, body: list };\n}\n',
        "test/etag.test.js",
        T(
          'import { conditional, etagOf } from "../src/etag.js";',
          'test("a matching tag is a 304", () => {\n  const l = [{ id: 1 }];\n  assert.equal(conditional(l, etagOf(l)).status, 304);\n});\ntest("the tag changes with the list", () => {\n  assert.notEqual(etagOf([]), etagOf([{ id: 1 }]));\n});',
        ),
        "feat(api): ETag and 304 on GET /tasks",
        "Added etagOf and conditional() with tests for both criteria.",
        0.52,
        12,
      ),
    ],
    tester: testerOf(
      "etag",
      'import { conditional } from "../../src/etag.js";',
      'test("a stale tag gets the body", () => {\n  assert.equal(conditional([{ id: 2 }], \'W/"stale"\').status, 200);\n});',
      "304s and fresh bodies both behave as described.",
      0.12,
    ),
  },
  {
    key: "undo",
    repo: "taskflow-core",
    title: "Undo the last change on the board",
    description:
      "A small history: withHistory(list) records each change and undo() returns the previous list.",
    acs: [
      "undo returns the list before the last change",
      "undo on an empty history returns the current list",
    ],
    risk: "medium",
    flow: "done",
    steps: [
      mod(
        "src/history.js",
        "export function withHistory(list) {\n  const past = [];\n  let current = list;\n  return {\n    get: () => current,\n    apply(fn) {\n      past.push(current);\n      current = fn(current);\n      return current;\n    },\n    undo() {\n      if (past.length) current = past.pop();\n      return current;\n    },\n  };\n}\n",
        "test/history.test.js",
        T(
          'import { withHistory } from "../src/history.js";',
          'test("undo steps back once", () => {\n  const h = withHistory([1]);\n  h.apply((l) => [...l, 2]);\n  assert.deepEqual(h.undo(), [1]);\n});\ntest("undo with no history is a no-op", () => {\n  assert.deepEqual(withHistory([1]).undo(), [1]);\n});',
        ),
        "feat(board): undo the last change",
        "Added withHistory with apply and undo, and tests for both criteria.",
        0.63,
        14,
      ),
    ],
    tester: testerOf(
      "undo",
      'import { withHistory } from "../../src/history.js";',
      'test("two undos step back twice", () => {\n  const h = withHistory([]);\n  h.apply((l) => [...l, 1]);\n  h.apply((l) => [...l, 2]);\n  h.undo();\n  assert.deepEqual(h.undo(), []);\n});',
      "Undo steps back one change at a time and stops at the start.",
      0.15,
    ),
  },
  {
    key: "column-counts",
    repo: "taskflow-web",
    title: "Show counts in the column headers",
    description: 'Each board column header shows how many cards it holds, e.g. "Open (12)".',
    acs: ["Column headers show their card count", "An empty column reads (0)"],
    risk: "medium",
    flow: "done",
    steps: [
      mod(
        "src/render/header.js",
        "export function columnHeader(name, cards) {\n  return `<h3>${name} (${cards.length})</h3>`;\n}\n",
        "test/header.test.js",
        T(
          'import { columnHeader } from "../src/render/header.js";',
          'test("headers count their cards", () => {\n  assert.equal(columnHeader("Open", [1, 2]), "<h3>Open (2)</h3>");\n});\ntest("an empty column reads (0)", () => {\n  assert.equal(columnHeader("Done", []), "<h3>Done (0)</h3>");\n});',
        ),
        "feat(board): counts in column headers",
        "Added columnHeader with tests for both criteria.",
        0.34,
        8,
      ),
    ],
    tester: testerOf(
      "column-counts",
      'import { columnHeader } from "../../src/render/header.js";',
      'test("the count follows the cards", () => {\n  assert.match(columnHeader("Open", [1, 2, 3]), /\\(3\\)/);\n});',
      "Counts follow the cards, including empty columns.",
      0.08,
    ),
  },
  {
    key: "collapse-done",
    repo: "taskflow-web",
    title: "Collapse the Done column by default",
    description:
      "The Done column starts collapsed and shows only its count; a click expands it and the choice is remembered.",
    acs: [
      "Done starts collapsed with its count showing",
      "Expanding it is remembered for the next visit",
    ],
    risk: "medium",
    flow: "review",
    steps: [
      mod(
        "src/render/collapse.js",
        'import { renderBoard } from "./board.js";\n\nexport function doneColumn(cards, prefs) {\n  const open = prefs.get("done-expanded") === "1";\n  return open\n    ? renderBoard(cards)\n    : `<button class="expand" aria-expanded="false">Done (${cards.length})</button>`;\n}\n',
        "test/collapse.test.js",
        T(
          'import { doneColumn } from "../src/render/collapse.js";',
          'test("Done starts collapsed", () => {\n  assert.match(doneColumn([1, 2], new Map()), /Done \\(2\\)/);\n});\ntest("an expanded choice is remembered", () => {\n  assert.match(doneColumn([{ title: "a" }], new Map([["done-expanded", "1"]])), /<ul/);\n});',
        ),
        "feat(board): collapse the Done column by default",
        "Added doneColumn: collapsed with its count unless the saved preference says expanded. Tests cover both criteria.",
        0.57,
        13,
      ),
    ],
    tester: testerOf(
      "collapse-done",
      'import { doneColumn } from "../../src/render/collapse.js";',
      'test("the collapsed column is a button", () => {\n  assert.match(doneColumn([], new Map()), /aria-expanded="false"/);\n});',
      "Collapsed by default, expanded when remembered.",
      0.13,
    ),
  },
  {
    key: "ci-workflow",
    repo: "taskflow-web",
    title: "Run the tests on every push",
    description:
      "A workflow that installs and runs npm test on every push and pull request, on the two supported node versions.",
    acs: [
      "The workflow runs npm test on push and pull request",
      "Both supported node versions are covered",
    ],
    risk: "medium",
    flow: "done_reviewed",
    steps: [
      {
        files: {
          ".github/workflows/test.yml":
            "name: test\non: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [22, 24]\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm test\n",
          "test/workflow.test.js": T(
            'import { readFileSync } from "node:fs";',
            'test("the workflow runs npm test on both node versions", () => {\n  const y = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");\n  assert.match(y, /run: npm test/);\n  assert.match(y, /node: \\[22, 24\\]/);\n});',
          ),
        },
        message: "ci: run the tests on every push and pull request",
        summary:
          "Added a test workflow (push and pull request, node 22 and 24, read-only token) and a test that reads it.",
        cost: 0.39,
        turns: 9,
      },
    ],
    tester: testerOf(
      "ci-workflow",
      'import { readFileSync } from "node:fs";',
      'test("the workflow token is read-only", () => {\n  const y = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8");\n  assert.match(y, /contents: read/);\n});',
      "The workflow covers push, pull request and both node versions with a read-only token.",
      0.09,
    ),
  },
  {
    key: "flaky-clock",
    repo: "taskflow-core",
    title: "Fix the flaky digest test around midnight",
    description:
      "test/digest.test.js uses the real clock in one place and fails when CI runs across midnight UTC.",
    acs: [{ text: "The digest tests pin the clock", check_command: "npm test" }],
    risk: "low",
    flow: "blocked",
    steps: [
      {
        files: {
          "test/midnight.test.js": T(
            'import { digestLines } from "../src/digest.js";',
            'test("the digest is stable across midnight", () => {\n  assert.equal(digestLines([{ title: "x", done: false, due: new Date().toISOString() }]).length, 2);\n});',
          ),
        },
        message: "test(digest): pin the clock around midnight",
        summary: "Added a midnight test for the digest.",
        cost: 0.33,
        turns: 9,
      },
    ],
  },
  {
    key: "audit-log",
    repo: "taskflow-api",
    title: "Audit log of task changes",
    description:
      "Record who changed what on every task mutation in an append-only log, queryable by task.",
    acs: ["Every mutation appends one audit row", "GET /tasks/:id/audit lists them newest first"],
    risk: "medium",
    flow: "ready",
  },
  {
    key: "webhooks",
    repo: "taskflow-api",
    title: "Webhooks for task events",
    description:
      "POST to a configured URL when a task is created, completed or deleted, with retries and backoff.",
    acs: [
      "A task event is delivered within 5 seconds",
      "Failed deliveries retry with backoff for up to a day",
    ],
    risk: "medium",
    flow: "draft",
  },
  {
    key: "markdown-titles",
    repo: "taskflow-web",
    title: "Render markdown in task titles",
    description: "Bold, italics and links in titles render on the card.",
    acs: ["Bold, italics and links render; anything else stays text"],
    risk: "low",
    flow: "cancelled",
    reason: "Titles stay plain text; links go in the description instead (agreed in review).",
  },
  {
    key: "ics-export",
    repo: "taskflow-api",
    title: "Calendar feed of due dates",
    description: "An ICS feed per user with one event per open task that has a due date.",
    acs: ["The feed validates and lists open dated tasks"],
    risk: "low",
    flow: "claimed",
  },
  {
    key: "theme-contrast",
    repo: "taskflow-web",
    title: "Raise contrast of muted text in the dark theme",
    description:
      "Muted text in the dark theme is under 4.5:1 on the card background; raise it to pass WCAG AA.",
    acs: ["Muted text is at least 4.5:1 on cards in both themes"],
    risk: "low",
    flow: "claimed",
  },
  {
    key: "search",
    repo: "taskflow-api",
    title: "Search tasks by title",
    description: "GET /tasks?q= matches titles case-insensitively.",
    acs: ["q matches titles case-insensitively"],
    risk: "low",
    flow: "draft",
  },
  {
    key: "due-filter-web",
    repo: "taskflow-web",
    title: "Filter the board to what is due this week",
    description:
      "A This week filter chip on the board that keeps tasks due in the next seven days.",
    acs: ["The chip keeps tasks due in the next 7 days"],
    risk: "low",
    flow: "paused",
    steps: [
      mod(
        "src/week.js",
        "const DAY = 86400000;\nexport function dueThisWeek(list, now = Date.now()) {\n  return list.filter((t) => t.due && Date.parse(t.due) - now <= 7 * DAY && Date.parse(t.due) >= now);\n}\n",
        "test/week.test.js",
        T(
          'import { dueThisWeek } from "../src/week.js";',
          'test("dueThisWeek keeps the next 7 days", () => {\n  const now = Date.parse("2026-05-01");\n  assert.equal(dueThisWeek([{ due: "2026-05-03" }, { due: "2026-05-20" }], now).length, 1);\n});',
        ),
        "feat(board): this week filter",
        "Added dueThisWeek; stopped at the turn cap before wiring the chip.",
        0.95,
        40,
      ),
    ],
  },
];

// Lore the factory has learned (approved through the Memory view's flow, by a person).
export const LORE = [
  {
    repo: "taskflow-core",
    kind: "convention",
    title: "Every list function returns a new list",
    summary: "Functions in src/ never mutate their input; they map, filter or spread.",
    body: "The board keeps the previous list for undo, so a mutation shows up as a phantom change. Cite: src/tasks.js, src/board.js.",
  },
  {
    repo: "taskflow-core",
    kind: "gotcha",
    title: "Tests must pin the clock",
    summary: "Anything that reads Date.now() takes now as a parameter; tests pass a fixed time.",
    body: "The digest and due-date tests failed across midnight UTC until the clock was a parameter. Cite: src/due.js, src/digest.js.",
  },
  {
    repo: "taskflow-api",
    kind: "convention",
    title: "Routes return { status, body }",
    summary:
      "Handlers are pure: they take the store and the request body and return status and body; the server writes the response.",
    body: "Keeps every route testable without a socket. Cite: src/server.js, src/routes/tasks.js.",
  },
  {
    repo: "taskflow-api",
    kind: "gotcha",
    title: "Compare signatures in constant time",
    summary: "Session signatures are compared with timingSafeEqual after a length check.",
    body: "A plain string compare leaks the signature a byte at a time. Cite: src/auth/session.js.",
  },
  {
    repo: "taskflow-web",
    kind: "convention",
    title: "Escape every title before it reaches markup",
    summary:
      "Rendering is string templates, so every user string goes through escape() in src/render/card.js.",
    body: "Titles come straight from users. Cite: src/render/card.js.",
  },
];

export const DRAFT_LORE = [
  {
    repo: "taskflow-web",
    kind: "gotcha",
    title: "Relative dates round to the nearest day",
    summary: "formatDue rounds, so 36 hours late reads as 2 days late.",
    body: "Suggested by a delivery agent after the yesterday fix. Cite: src/format.js.",
  },
];

// Every delivery ends with the smallest-change note the runner's minimalism check reads,
// naming the files it touched, as the delivery prompt asks an agent to.
for (const t of [...EPICS.flatMap((e) => e.tickets), ...LOOSE])
  for (const s of t.steps || [])
    if (s.summary && !/Smallest-change note/.test(s.summary))
      s.summary +=
        `\n\nSkills used: ${/^fix|^test/.test(s.message || "") ? "fix-bug, add-unit-test" : "add-unit-test, engineering-craft"}.` +
        `\n\nSmallest-change note: touched ${Object.keys(s.files).join(" and ")} only.`;
