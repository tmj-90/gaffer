// Ticket setup for the runner tests in ONE node process instead of one `wg` call per
// step. A test's `new_ticket` helper was 4-6 dispatch CLI calls (ticket create, ac add,
// ticket repo-access set, ticket set-testable, ticket ready) plus a json-tool call, each
// a fresh node paying ~250 ms of module loading; a test that sets up nine tickets spent
// ~13 s of CI time on that alone. This makes the SAME service calls the CLI commands
// make (packages/dispatch/src/cli/commands/ticket.ts and ac.ts: the same Dispatch
// methods, the same arguments and defaults, the same human actor `$USER`), in the same
// order, so the database ends up exactly as the CLI sequence leaves it.
//
//   node wg-batch.mjs DB [--risk R] [--policy P] [--ac TEXT]... [--repo NAME]...
//                     [--testable] [--ready] TICKET...
//
// TICKET is "title<TAB>description", or "title<TAB>description<TAB>plain" to skip
// --testable for that one ticket. In an --ac TEXT, "{n}" is the ticket's number (a
// loop's `wg ac add "$n" -t "AC$n"` is --ac 'AC{n}'). Tickets are created in argument order (so their
// numbers are too); each step runs on its own and a refused step is reported on stderr
// and does not stop the next, as the shell sequence with `2>/dev/null` did. Prints one
// ticket number per line, in order (an empty line where the create itself failed, and
// then exits 1).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../../../packages/dispatch/dist/core.js");

function die(msg) {
  process.stderr.write(`wg-batch: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const db = argv.shift();
if (!db)
  die(
    "usage: wg-batch.mjs DB [--risk R] [--policy P] [--ac TEXT]... [--repo NAME]... [--testable] [--ready] TICKET...",
  );
const opts = {
  risk: "medium",
  policy: "solo_loose",
  acs: [],
  repos: [],
  testable: false,
  ready: false,
};
const tickets = [];
while (argv.length) {
  const a = argv.shift();
  if (a === "--risk") opts.risk = argv.shift();
  else if (a === "--policy") opts.policy = argv.shift();
  else if (a === "--ac") opts.acs.push(argv.shift());
  else if (a === "--repo") opts.repos.push(argv.shift());
  else if (a === "--testable") opts.testable = true;
  else if (a === "--ready") opts.ready = true;
  else if (a.startsWith("--")) die(`unknown option ${a}`);
  else {
    const [title, description = "", mode = ""] = a.split("\t");
    if (!title) die(`a TICKET needs a title: '${a}'`);
    tickets.push({ title, description, plain: mode === "plain" });
  }
}

// The CLI refuses a database that does not exist (it never creates one by accident).
if (!existsSync(db)) die(`no database at ${db} (wg init first)`);
const { Dispatch } = await import(CORE);
// The CLI's open(): an existing DB, the same option the CLI passes.
const wg = Dispatch.open(db, undefined, undefined, { requireRegisteredAgentApprover: true });
const actor = { type: "human", id: process.env.USER ?? "cli" }; // cli/shared.ts cliActor()
const step = (what, fn) => {
  try {
    fn();
  } catch (e) {
    process.stderr.write(`wg-batch: ${what}: ${e && e.message ? e.message : e}\n`);
  }
};
let failed = false;
const out = [];
for (const t of tickets) {
  let created;
  try {
    // `ticket create`: priority 0 and bootstrap false are its option defaults.
    created = wg.createTicket(
      {
        title: t.title,
        description: t.description,
        policy_pack: opts.policy,
        risk_level: opts.risk,
        priority: 0,
        bootstrap: false,
      },
      actor,
    );
  } catch (e) {
    process.stderr.write(
      `wg-batch: ticket create '${t.title}': ${e && e.message ? e.message : e}\n`,
    );
    failed = true;
    out.push("");
    continue;
  }
  for (const text of opts.acs) {
    // `ac add <n> -t TEXT`: no --verify, --evidence false.
    step(`ac add #${created.number}`, () =>
      wg.addAcceptanceCriterion(
        {
          ticket_id: created.id,
          text: text.split("{n}").join(String(created.number)),
          verification_method: undefined,
          evidence_required: false,
        },
        actor,
      ),
    );
  }
  for (const repo of opts.repos) {
    // `ticket repo-access set <n> REPO --access write --relation confirmed` (source manual).
    step(`repo-access set #${created.number} ${repo}`, () =>
      wg.setTicketRepoAccess(
        {
          ticket_id: String(created.number),
          repo_id: repo,
          access: "write",
          relation: "confirmed",
          source: "manual",
        },
        actor,
      ),
    );
  }
  if (opts.testable && !t.plain) {
    step(`set-testable #${created.number}`, () =>
      wg.setTestable(String(created.number), true, actor),
    );
  }
  if (opts.ready) {
    step(`ready #${created.number}`, () =>
      wg.markReady(wg.resolveTicket(String(created.number)).id, actor),
    );
  }
  out.push(String(created.number));
}
wg.db.close();
process.stdout.write(out.join("\n") + "\n");
process.exit(failed ? 1 : 0);
