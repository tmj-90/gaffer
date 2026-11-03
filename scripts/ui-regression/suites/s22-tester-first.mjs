// S22 tester first, end to end in the shared world, with GAFFER_TESTING unset (the `auto`
// default: the sample repo has a registered test command, so the lane is on for it).
//   delivery → Testing (before the human review; an approval of the untested commit is
//   refused) → tester FAIL → Refining → the next attempt's prompt carries the tester's
//   observation as quarantined review feedback → tester PASS → back in Review, where the
//   sign-off names the tested commit;
//   a push to the delivery branch after the PASS → not approvable (held, the server
//   refuses) until a Poll sends the new head to the tester and it passes → the person
//   approves the tested commit → Merge now lands it → done.
export default async function s22(t, L) {
  const p = t.page;

  const health = (await L.api("GET", "/api/health")).json || {};
  t.check(
    health.tester_lane?.mode === "auto" &&
      !(health.tester_lane.notices || []).some((n) => n.includes("taskflow-mini")),
    "Health: the tester lane is on auto, and the sample repo (a registered test command) has no off notice",
    `Health tester_lane: ${JSON.stringify(health.tester_lane)}`,
  );

  const tk = await L.seedTicket(t, {
    title: `Tester first (${L.tag("s22")})`,
    acs: ["the task list still grows"],
  });
  L.setStubMode(tk.number, "tester_fail");
  const tb = await L.api("POST", `/tickets/${tk.id}/testable`, { can_be_tested: true });
  const rd = await L.api("POST", `/tickets/${tk.id}/ready`);
  t.check(
    tb.status < 300 && rd.status < 300,
    `#${tk.number}: testable and ready`,
    `${tb.status} ${rd.status}`,
  );

  const settle = ["in_testing", "in_review", "refining", "ready_for_merge", "blocked", "done"];
  const pollUntil = async (want, label, tries = 4) => {
    for (let i = 0; i < tries; i++) {
      await t.visit("work");
      await t.poll();
      await L.maybe(
        async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
        "tick done",
        240000,
        1000,
      );
      const st = await L.waitStatus(tk.id, settle, 30000, 1000);
      if (st && want.includes(st.status)) return st;
    }
    t.bad(
      `${label}: #${tk.number} is '${(await L.ticketOf(tk.id)).status}' · ${await L.whyStuck(tk, t.lastPoll)}`,
    );
    return null;
  };

  // ── 1. the delivery goes to the tester before the person sees it ────────────
  const d1 = await pollUntil(["in_testing"], "first delivery");
  if (!d1) return;
  t.check(true, `#${tk.number} delivered → Testing, before the human review`, "");
  const shownHeads = ((await L.api("GET", `/tickets/${tk.id}/diff`)).json.repos || []).map((r) => ({
    repo: r.repoId,
    sha: r.headSha,
  }));
  const early = await L.api("POST", `/tickets/${tk.id}/review/approve`, { commits: shownHeads });
  t.check(
    early.status === 409 && early.json?.error?.details?.reason === "not_tested",
    "an approval before the tester's verdict is refused (409)",
    `early approve: ${early.status} ${JSON.stringify(early.json).slice(0, 200)}`,
  );

  // ── 2. tester FAIL → Refining, its observation is the rework feedback ───────
  const f1 = await pollUntil(["refining"], "tester FAIL");
  if (!f1) return;
  t.check(true, `tester FAIL → #${tk.number} back in Refining (no human review spent)`, "");

  // ── 3. the next attempt's prompt carries the observation, quarantined ───────
  L.setStubMode(tk.number, "tester_pass");
  const again = await L.api("POST", `/tickets/${tk.id}/ready`);
  t.check(again.status < 300, "the human readies it again from Refining", `ready: ${again.status}`);
  const d2 = await pollUntil(["in_testing"], "second delivery");
  if (!d2) return;
  const calls = L.stubCalls({ kind: "delivery", ticket: tk.number });
  const prompt = (calls[calls.length - 1] || {}).prompt || "";
  const env = (prompt.match(/<untrusted-review-feedback>[\s\S]*?<\/untrusted-review-feedback>/) || [
    "",
  ])[0];
  t.check(
    calls.length >= 2 &&
      /PRIOR REVIEW FEEDBACK/.test(prompt) &&
      /tester_failed:/.test(env) &&
      /keeps completed tasks/.test(env),
    "the next attempt's prompt carries the tester's FAIL observation inside the review-feedback envelope",
    `attempt ${calls.length} feedback envelope: '${env.slice(0, 240) || "(none)"}'`,
  );

  // ── 4. tester PASS → back in Review; the sign-off names the tested commit ───
  const r1 = await pollUntil(["in_review"], "tester PASS");
  if (!r1) return;
  const branch = (await L.ticketOf(tk.id)).branch_name;
  const tested = L.git(L.REPO_PATH, "rev-parse", `refs/heads/${branch}`).trim();
  await t.visit(`review/${tk.id}`, { label: "review/:id" });
  await L.maybe(
    async () => ((await p.textContent(".signoff-next").catch(() => "")) || "").trim() || null,
    "sign-off line",
    20000,
    500,
  );
  const line1 = (await p.textContent(".signoff-next").catch(() => "")) || "";
  const tcell = (await p.textContent(".vd-cell.vd-tester").catch(() => "")) || "";
  t.check(
    line1.includes(`You approve tested commit ${tested.slice(0, 12)}`) && /Passed/.test(tcell),
    "Review shows the tester's PASS, and the sign-off names the tested commit",
    `sign-off: '${line1.slice(0, 200)}' · tester cell: '${tcell.slice(0, 160)}'`,
  );

  // ── 5. a push after the PASS: not approvable until re-tested ────────────────
  const wt = `${L.GAFFER_DATA}/s22-push-${tk.number}`;
  L.git(L.REPO_PATH, "worktree", "add", "-q", wt, branch);
  L.git(wt, "commit", "-q", "--allow-empty", "-m", "a push after the tester's PASS");
  L.git(L.REPO_PATH, "worktree", "remove", "--force", wt);
  const pushed = L.git(L.REPO_PATH, "rev-parse", `refs/heads/${branch}`).trim();
  const held = await t.approve(tk);
  t.check(
    held?.status === "in_review" && /not tested on this commit/i.test(held?.held || ""),
    `after a push the approval is held server-side (${pushed.slice(0, 12)} is not the tested commit)`,
    `approve after the push: '${held?.status}' button='${held?.held || ""}'`,
  );
  const r2 = await pollUntil(["in_review"], "re-test after the push");
  if (!r2) return;
  const verdicts = (await L.ticketView(tk.id)).events.filter(
    (e) => e.event_type === "ticket.tester_passed",
  );
  const lastPass = JSON.parse(verdicts[verdicts.length - 1]?.payload_json || "{}");
  t.check(
    verdicts.length >= 2 && lastPass.tested_head === pushed,
    "a Poll sent the pushed head to the tester, and its PASS is on that commit",
    `tester passes: ${verdicts.length}, last tested_head=${lastPass.tested_head} pushed=${pushed}`,
  );

  // ── 6. the person approves the tested commit; Merge now lands it ────────────
  const ap = await t.approve(tk);
  t.check(
    ap?.status === "ready_for_merge",
    `approving the re-tested commit → Ready for merge`,
    `approve: '${ap?.status}' ${ap?.held || ""}`,
  );
  if (ap?.status !== "ready_for_merge") return;
  await L.api("POST", `/tickets/${tk.id}/merge`);
  const done = await L.waitStatus(tk.id, ["done", "blocked"], 120000, 1000);
  t.check(
    done?.status === "done",
    `Merge now landed #${tk.number} (done)`,
    `after Merge now: '${done?.status}' · ${await L.whyStuck(tk, t.lastPoll)}`,
  );
}
