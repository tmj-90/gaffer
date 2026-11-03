// S23 acceptance profile (cli), end to end in the shared world: a person registers the
// commands the runner runs for a ticket's cli profile, the tester tests first, its PASS
// survives the clean replay, the RUNNER then runs those commands on the same clean
// checkout and records the transcript, and only then is the PASS recorded; the Review
// packet backs it with "cli transcript replayed" and the ticket page shows the transcript
// as expandable text by the runner on the tested commit. A second ticket whose registered
// expectation does not hold is HELD in testing with the reason on the ticket.
export default async function s23(t, L) {
  const p = t.page;
  const settle = ["in_testing", "in_review", "refining", "ready_for_merge", "blocked", "done"];
  const pollUntil = async (tk, want, label, tries = 4) => {
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
  const seed = async (title, spec) => {
    const tk = await L.seedTicket(t, {
      title: `${title} (${L.tag("s23")})`,
      acs: ["addTask still appends"],
    });
    L.setStubMode(tk.number, "tester_pass");
    const tb = await L.api("POST", `/tickets/${tk.id}/testable`, { can_be_tested: true });
    const ap = await L.api("POST", `/tickets/${tk.id}/acceptance-profile`, {
      profile: "cli",
      spec,
    });
    const rd = await L.api("POST", `/tickets/${tk.id}/ready`);
    t.check(
      tb.status < 300 && ap.status < 300 && rd.status < 300 && ap.json?.profile === "cli",
      `#${tk.number}: testable, cli acceptance profile registered, ready`,
      `${tb.status} ${ap.status} ${JSON.stringify(ap.json).slice(0, 160)} ${rd.status}`,
    );
    return tk;
  };

  // ── 1. a registered CLI transcript backs the tester's PASS ──────────────────
  const tk = await seed("Acceptance cli", {
    cases: [
      {
        name: "addTask from the command line",
        argv: [
          "node",
          "-e",
          "import('./src/tasks.js').then((m) => console.log('tasks:' + m.addTask([], 'x').length))",
        ],
        expect: { exit: 0, stdout: ["tasks:1"] },
      },
      {
        name: "a failing command exits non-zero",
        argv: ["node", "-e", "process.exit(3)"],
        expect: { exit: 3 },
      },
    ],
  });
  // An agent-shaped write cannot change it: the MCP/agent path never registers commands.
  const agentTry = await L.api("POST", `/tickets/${tk.id}/acceptance-profile`, { profile: "nope" });
  t.check(agentTry.status === 422, "an unknown profile is refused (422)", `${agentTry.status}`);
  const r1 = await pollUntil(tk, ["in_review"], "tester PASS with the cli transcript");
  if (!r1) return;
  const view = await L.ticketView(tk.id);
  const rows = (view.evidence || []).filter((e) =>
    String(e.uri || "").startsWith("gaffer-acceptance:cli:"),
  );
  const payload = JSON.parse(rows[rows.length - 1]?.payload_json || "{}");
  const passEv = (view.events || []).filter((e) => e.event_type === "ticket.tester_passed").pop();
  const tested = JSON.parse(passEv?.payload_json || "{}").tested_head || "";
  t.check(
    rows.length >= 1 &&
      rows[rows.length - 1].recorded_by_actor_type === "system" &&
      payload.kind === "transcript" &&
      payload.passed === true &&
      payload.cases?.length === 2 &&
      payload.tested_commit === tested,
    "the runner recorded the cli transcript (system, passed, both commands) on the tested commit",
    `rows=${rows.length} payload=${JSON.stringify(payload).slice(0, 240)} tested=${tested}`,
  );
  const verdict = (view.evidence || [])
    .filter((e) => e.evidence_type === "test_output")
    .map((e) => JSON.parse(e.payload_json || "{}"))
    .filter((x) => x.verdict === "pass")
    .pop();
  t.check(
    verdict?.acceptance?.profile === "cli" &&
      verdict.acceptance.evidence_id === rows[rows.length - 1]?.id,
    "the tester's PASS is bound to that transcript",
    JSON.stringify(verdict).slice(0, 240),
  );
  const dossier = (await L.api("GET", `/tickets/${tk.id}/dossier?include=packet`)).json || {};
  const backing = dossier.review_packet?.backing || [];
  const row = backing.find((b) => b.cell === "evidence");
  t.check(
    row?.holds === true && /cli transcript replayed on/.test(row.fact),
    "the Review packet backs it: runtime acceptance, cli transcript replayed",
    JSON.stringify(row),
  );
  await t.visit(`ticket/${tk.id}`, { label: "ticket/:id" });
  await L.maybe(
    async () => (await p.$(".tk-accept-row")) || null,
    "runtime acceptance row",
    20000,
    500,
  );
  const rowText = (await p.textContent(".tk-accept-row summary").catch(() => "")) || "";
  await p.click(".tk-accept-row summary").catch(() => null);
  const pre = (await p.textContent(".tk-accept-row pre").catch(() => "")) || "";
  t.check(
    /by runner/.test(rowText) &&
      rowText.includes(tested.slice(0, 12)) &&
      /\$ node -e/.test(pre) &&
      /tasks:1/.test(pre) &&
      /exit 3/.test(pre),
    "the ticket page shows the transcript by the runner on the tested commit, as text",
    `summary='${rowText.slice(0, 160)}' pre='${pre.slice(0, 200)}'`,
  );

  // ── 2. an expectation that does not hold: the PASS is held for a person ─────
  const tk2 = await seed("Acceptance cli held", {
    cases: [{ argv: ["node", "-e", "console.log('tasks:0')"], expect: { stdout: ["tasks:1"] } }],
  });
  const h = await pollUntil(tk2, ["in_testing"], "second delivery to testing");
  if (!h) return;
  // One more tick: the tester runs, its PASS is held on the runtime acceptance.
  let note = "";
  for (let i = 0; i < 4 && !note; i++) {
    await t.poll();
    await L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "tick done",
      240000,
      1000,
    );
    const v2 = await L.ticketView(tk2.id);
    note =
      (
        (v2.evidence || []).find((e) =>
          /^tester held: runtime acceptance \(cli\) did not pass/.test(e.summary || ""),
        ) || {}
      ).summary || "";
  }
  const st2 = (await L.ticketOf(tk2.id)).status;
  t.check(
    st2 === "in_testing" && /stdout has tasks:1/.test(note),
    "a transcript whose expectation does not hold HOLDS the PASS in testing, with the reason on the ticket",
    `status=${st2} note='${note.slice(0, 240)}'`,
  );
}
