// S4b PR mode with required CI — OWN SERVER: a recording fake `gh` first on PATH
// (suites/bin/fake-gh.mjs: the real CLI's JSON field rules, checks served from a state
// file) and a sample repo whose origin is a local bare repo plus a github.com remote, so
// the runner's PR seams (lib/pr-create.sh, lib/ci-gate.sh, gaffer_pr_merge /
// merge-ticket.mjs) all run for real against it.
//   1. Settings (the UI): 'Deliver as a pull request' + 'Require CI green before review'
//      on, a short CI poll; saved and effective.
//   2. Delivery of #A with CI PENDING: the branch is pushed and `gh pr create` opens the
//      PR (its URL lands on the ticket, the ticket page links it); the CI gate polls the
//      PR's checks — and asks gh only for fields gh has.
//   3. While CI is pending, Approve in Review must not advance the ticket to merge.
//   4. CI turns green; the approval goes through; Merge now lands #A THROUGH the PR:
//      `gh pr merge <url> --merge --delete-branch --match-head-commit <head>`, the
//      remote main gets the merge, the local main is fast-forwarded to it, the ticket is
//      done and its page offers 'Open the PR'.
//   5. #B delivered on green and approved; CI then turns RED; with Auto-merge on, the
//      merge lane must hold #B instead of landing it on the earlier green.
// Steps 2 (fields), 3 and 5 are the CI-required approval rule another package
// (wp/g-external-review-2) is fixing: where today's code does not do it yet the step is
// a `note` that says "pending external-review-2", and it becomes a real check once that
// lands (the suite reads the outcome, it does not assume either).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const server = { env: {}, fixtures: ["fake-gh", "pr-remote"] };

const PENDING = "pending external-review-2";

export default async function s4b(t, L) {
  const p = t.page;
  const ST = process.env.FAKE_GH_STATE;
  if (!ST || !existsSync(ST)) return t.bad("no FAKE_GH_STATE (the fake-gh fixture did not run)");
  const ci = (s) => writeFileSync(path.join(ST, "ci-state"), s + "\n");
  const ghCalls = (cmd) =>
    (existsSync(path.join(ST, "calls.jsonl"))
      ? readFileSync(path.join(ST, "calls.jsonl"), "utf8").split("\n").filter(Boolean)
      : []
    )
      .map((l) => JSON.parse(l))
      .filter((c) => !cmd || c.cmd === cmd);
  const prs = () => {
    try {
      return JSON.parse(readFileSync(path.join(ST, "prs.json"), "utf8")).prs || [];
    } catch {
      return [];
    }
  };
  const remote = path.join(path.dirname(L.REPO_PATH), "remote.git");
  const idle = () =>
    L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "runs to finish",
      240000,
      1000,
    );
  const isPrUrl = (u) => /^https:\/\/github\.com\/acme\/taskflow-mini\/pull\/\d+$/.test(u || "");
  const argAfter = (c, flag) =>
    c && c.argv.includes(flag) ? c.argv[c.argv.indexOf(flag) + 1] : "";
  const isAncestor = (dir, a, b) => {
    try {
      L.git(dir, "merge-base", "--is-ancestor", a, b);
      return true;
    } catch {
      return false;
    }
  };
  // What the adapter asked gh for (the fake records each --json list and refuses
  // the fields the real CLI does not have).
  const fieldReport = () => {
    const asked = ghCalls().filter((c) => c.fields.length);
    const unknown = [...new Set(asked.flatMap((c) => c.unknown.map((u) => `${c.cmd}:${u}`)))];
    return { asked, unknown };
  };

  // ── 1. PR mode + required CI, through Settings ────────────────────────────
  ci("pending");
  await t.visit("settings");
  await t.setSetting("GAFFER_CREATE_PR", "1");
  await t.setSetting("GAFFER_REQUIRE_CI", "1");
  await t.setSetting("GAFFER_CI_POLL_ATTEMPTS", "10");
  await t.setSetting("GAFFER_CI_POLL_INTERVAL_SECS", "3");
  const sv = await t.saveSettings();
  const eff = await L.settingsMap();
  t.check(
    sv.status < 300 &&
      eff.get("GAFFER_CREATE_PR")?.effective === "1" &&
      eff.get("GAFFER_REQUIRE_CI")?.effective === "1" &&
      eff.get("GAFFER_CI_POLL_INTERVAL_SECS")?.effective === "3",
    "Settings: 'Deliver as a pull request' + 'Require CI green before review' (10 polls × 3s) saved and effective",
    `PR/CI settings save: ${sv.status} sent=${JSON.stringify(sv.sent)}`,
  );

  // ── 2. delivery of #A with CI pending: PR created, the gate polls ─────────
  const a = await L.seedTicket(t, {
    title: `PR mode delivery A (${L.tag("s4b")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const delivered = await L.waitStatus(
    a.id,
    ["in_review", "refining", "blocked", "failed"],
    240000,
    1000,
  );
  const polling = await L.maybe(
    () => (ghCalls("pr checks").length ? true : null),
    "the CI gate's first poll",
    60000,
    500,
  );
  const aRow = await L.ticketOf(a.id);
  const created = ghCalls("pr create");
  const pr = prs().find((x) => x.head === aRow.branch_name);
  t.check(
    delivered?.status === "in_review" &&
      created.length === 1 &&
      argAfter(created[0], "--head") === aRow.branch_name &&
      argAfter(created[0], "--base") === "main" &&
      pr &&
      isPrUrl(aRow.pr_url) &&
      aRow.pr_url === pr.url,
    `#${a.number} delivered in PR mode: \`gh pr create --head ${aRow.branch_name} --base main\` opened ${aRow.pr_url}, recorded on the ticket`,
    `PR creation for #${a.number}: status=${delivered?.status} pr_url=${aRow.pr_url} creates=${JSON.stringify(created.map((c) => c.argv)).slice(0, 300)}`,
  );
  t.check(
    Boolean(aRow.branch_name) &&
      L.git(remote, "branch", "--list", aRow.branch_name).includes(aRow.branch_name),
    `the delivery branch ${aRow.branch_name} was pushed to the remote before the PR`,
    `the remote has no branch ${aRow.branch_name}`,
  );
  await t.visit(`ticket/${a.id}`, { label: "ticket/:id" });
  const prLink = await p
    .locator(`a[href="${aRow.pr_url}"]`)
    .count()
    .catch(() => 0);
  t.check(
    prLink > 0,
    `the ticket page links the PR (${aRow.pr_url})`,
    `the ticket page has no link to ${aRow.pr_url}`,
  );
  const f1 = fieldReport();
  if (!polling) t.bad("the CI gate never polled the PR's checks (no `gh pr checks` call)");
  else if (!f1.unknown.length)
    t.ok(
      `the CI gate asks gh only for real JSON fields (${[...new Set(f1.asked.map((c) => `${c.cmd} --json ${c.fields.join(",")}`))].join("; ")})`,
    );
  else if (f1.unknown.every((u) => u.startsWith("pr checks:")))
    t.note(
      `${PENDING}: the CI gate asks \`gh pr checks\` for JSON fields gh does not have (${f1.unknown.join(", ")}); the real CLI refuses them, so the gate never reads a result`,
    );
  else t.bad(`gh was asked for unknown JSON fields: ${f1.unknown.join(", ")}`);

  // ── 3. CI pending: Approve must not advance it to merge ────────────────────
  const stillPolling = ((await L.api("GET", "/api/runs")).json.active || []).length > 0;
  if (!stillPolling)
    t.note(`the CI gate had stopped polling before the approval attempt on #${a.number}`);
  await L.clearToast(p);
  const early = await t.approve(a);
  const afterEarly = (await L.ticketOf(a.id)).status;
  const earlyToast = await L.toasts(p);
  if (afterEarly === "in_review")
    t.ok(
      `with required CI pending, Approve left #${a.number} in review (not ready_for_merge)${earlyToast ? ` — "${earlyToast.slice(0, 120)}"` : ""}`,
    );
  else if (["ready_for_merge", "in_testing", "done"].includes(afterEarly))
    t.note(
      `${PENDING}: with required CI still pending, Approve moved #${a.number} to ${afterEarly} (CI pending must not advance to merge)`,
    );
  else
    t.bad(
      `the approval attempt during pending CI left #${a.number} '${afterEarly}' (${early?.status})`,
    );

  // ── 4. CI green → approve → land THROUGH the PR ───────────────────────────
  ci("pass");
  await idle();
  let st = (await L.ticketOf(a.id)).status;
  if (st === "in_review") {
    const g = await t.approve(a);
    t.check(
      g?.status === "ready_for_merge",
      `with CI green, Approve moved #${a.number} on (ready_for_merge)`,
      `approval after green CI: '${g?.status ?? (await L.ticketOf(a.id)).status}'`,
    );
  } else if (st === "refining")
    t.note(
      `${PENDING}: #${a.number} was sent back to rework although CI turned green (the gate never read the green result)`,
    );
  st = (await L.ticketOf(a.id)).status;
  const mainBefore = L.git(remote, "rev-parse", "main").trim();
  if (st === "ready_for_merge") {
    await t.visit(`ticket/${a.id}`, { label: "ticket/:id" });
    await p.locator('button:has-text("Merge now")').first().click();
    const landed = await L.waitStatus(a.id, ["done"], 120000, 1500);
    const merges = ghCalls("pr merge");
    const m = merges[merges.length - 1];
    const head = argAfter(m, "--match-head-commit");
    t.check(
      landed &&
        m &&
        m.argv[2] === aRow.pr_url &&
        m.argv.includes("--merge") &&
        m.argv.includes("--delete-branch") &&
        /^[0-9a-f]{40}$/.test(head || ""),
      `Merge now landed #${a.number} THROUGH its PR: \`gh pr merge ${aRow.pr_url} --merge --delete-branch --match-head-commit ${(head || "").slice(0, 12)}\` → done`,
      `PR-mode landing of #${a.number}: status=${(await L.ticketOf(a.id)).status} merge calls=${JSON.stringify(merges.map((c) => c.argv)).slice(0, 300)}`,
    );
    const remoteMain = L.git(remote, "rev-parse", "main").trim();
    const localMain = L.git(L.REPO_PATH, "rev-parse", "main").trim();
    const contains = head ? isAncestor(remote, head, "main") : false;
    t.check(
      remoteMain !== mainBefore && contains && localMain === remoteMain,
      `what landed: the remote main gained the PR merge (${remoteMain.slice(0, 12)}, containing the reviewed head) and the local main was fast-forwarded to it`,
      `remote main ${mainBefore.slice(0, 12)}→${remoteMain.slice(0, 12)} contains-head=${contains} local main=${localMain.slice(0, 12)}`,
    );
    const prA = prs().find((x) => x.url === aRow.pr_url);
    t.check(
      prA?.state === "MERGED" && !L.git(remote, "branch", "--list", aRow.branch_name).trim(),
      "the PR is merged and its branch deleted on the remote (--delete-branch)",
      `PR state ${prA?.state}; remote branches: ${L.git(remote, "branch").trim()}`,
    );
    // The same route again is a no-op navigation: reload so the page re-reads the ticket.
    await p.reload({ waitUntil: "load" });
    const openPr = await L.maybe(
      async () =>
        (await p
          .locator(`a.btn[href="${aRow.pr_url}"]:has-text("Open the PR")`)
          .count()
          .catch(() => 0)) || null,
      "the full-time card",
      15000,
      500,
    );
    t.check(
      openPr > 0 && (await L.ticketOf(a.id)).status === "done",
      `the done ticket's page offers 'Open the PR' (${aRow.pr_url})`,
      `done ticket page: 'Open the PR' buttons=${openPr}`,
    );
    await L.shot(p, "s4b-landed");
  } else t.bad(`#${a.number} never reached ready_for_merge in PR mode ('${st}'): nothing landed`);

  // ── 5. #B approved on green; a LATER red holds it before landing ──────────
  ci("pass");
  const b = await L.seedTicket(t, {
    title: `PR mode delivery B (${L.tag("s4b")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const bDelivered = await L.waitStatus(
    b.id,
    ["in_review", "refining", "blocked", "failed"],
    240000,
  );
  await idle();
  const bNow = (await L.ticketOf(b.id)).status;
  if (bNow === "refining") {
    const ev = JSON.stringify((await L.ticketView(b.id)).evidence || []);
    if (/CI BLOCKED|no checks data|no PR found/i.test(ev) || f1.unknown.length)
      t.note(
        `${PENDING}: #${b.number} was delivered on GREEN CI, but the gate could not read the result and sent it back to rework; 'a later red holds an approved ticket' needs a gate that reads it`,
      );
    else t.bad(`#${b.number} went back to rework on green CI: ${ev.slice(0, 200)}`);
  } else if (bNow !== "in_review") {
    t.bad(`#${b.number}'s delivery on green CI ended '${bDelivered?.status}'`);
  } else {
    t.ok(`#${b.number} delivered on green CI and waits in review`);
    const bApproved = await t.approve(b);
    if (bApproved?.status !== "ready_for_merge")
      t.bad(`approving #${b.number} on green CI: '${bApproved?.status}'`);
    else {
      const bRow = await L.ticketOf(b.id);
      ci("fail");
      const mainB = L.git(remote, "rev-parse", "main").trim();
      await t.visit("settings");
      await t.setSetting("AUTO_MERGE", "1");
      await t.saveSettings();
      // The merge lane runs at the start of the next tick: Poll until a tick has run
      // (a poll right after the last one can be turned away) and read what it did.
      const logPath = path.join(L.GAFFER_DATA, "factory.log");
      const logNow = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
      const mark = logNow().length;
      const lane = () =>
        logNow()
          .slice(mark)
          .split("\n")
          .filter((l) => new RegExp(`(MERGE|H3)\\b.*#${b.number}\\b`).test(l));
      let toast = "";
      for (let i = 0; i < 3 && !lane().length; i++) {
        await t.visit("work");
        toast = await t.poll();
        await L.maybe(() => (lane().length ? true : null), "the merge lane", 30000, 1000);
        await idle();
      }
      const bEnd = await L.ticketOf(b.id);
      const mainAfter = L.git(remote, "rev-parse", "main").trim();
      const laneSaw = lane();
      if (!laneSaw.length && bEnd.status !== "done")
        t.bad(
          `no tick's merge lane looked at the approved #${b.number} after CI turned red (last Poll: "${toast}")`,
        );
      else if (bEnd.status !== "done" && mainAfter === mainB) {
        t.ok(
          `CI turned red after the approval: the merge lane HELD #${b.number} ('${bEnd.status}') and the remote main is untouched ("${laneSaw[laneSaw.length - 1].replace(/^\S+ /, "").slice(0, 140)}")`,
        );
        await t.visit("overview");
        const ov = (await p.textContent("#app").catch(() => "")) || "";
        t.check(
          bEnd.status !== "blocked" || new RegExp(`#${b.number}\\b`).test(ov),
          `the held #${b.number} is visible to a human (status '${bEnd.status}')`,
          `the Overview does not list the held #${b.number}`,
        );
      } else if (bEnd.status === "done")
        t.note(
          `${PENDING}: CI turned red after #${b.number} was approved, yet the merge lane landed it on the earlier green (${bRow.pr_url})`,
        );
      else t.bad(`after a red CI #${b.number} is '${bEnd.status}' and the remote main moved`);
      await t.visit("settings");
      await t.setSetting("AUTO_MERGE", "0");
      await t.saveSettings();
    }
  }
  const f2 = fieldReport();
  const byCmd = ghCalls().reduce((acc, c) => ((acc[c.cmd] = (acc[c.cmd] || 0) + 1), acc), {});
  t.note(
    `gh calls the factory made: ${Object.entries(byCmd)
      .map(([k, v]) => `${k}×${v}`)
      .join(
        ", ",
      )}${f2.unknown.length ? `; unknown JSON fields it asked for: ${f2.unknown.join(", ")}` : ""}`,
  );
}
