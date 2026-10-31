// S10 pause / continue, poll refusals and caps. A delivery that hits the turn cap
// PAUSES in place (worktree kept); the ticket page says why and offers Continue and
// Stop; Continue + Poll resumes it in its worktree; Stop abandons it and the next
// tick's sweep reaps its worktree. Then the caps a Poll honours, each lowered from Settings: the
// per-day tick cap, the per-day USD cap and the lifetime budget each refuse the poll
// with the runner's reason in a toast and launch no agent; an empty queue with the
// idle loops off says there is nothing to do.
import { existsSync } from "node:fs";

export default async function s10(t, L) {
  const p = t.page;
  const pause = async (title) => {
    const tk = await L.seedTicket(t, {
      title: `${title} (${L.tag("s10")})`,
      acs: ["covered by a test"],
      ready: true,
    });
    L.setStubMode(tk.number, "pause_first");
    await t.visit("work");
    await t.poll();
    const st = await L.waitStatus(tk.id, L.SETTLED, 240000);
    t.check(
      st?.status === "paused",
      `a delivery that hit the turn cap paused in place (#${tk.number} → paused)`,
      `turn-cap delivery #${tk.number} ended '${st?.status}'`,
    );
    return tk;
  };

  // ── pause → Stop abandons it ──────────────────────────────────────────────
  const b = await pause("Pause and stop");
  const wt = L.stubCalls({ kind: "delivery", ticket: b.number })[0]?.cwd;
  await t.visit(`ticket/${b.id}`);
  await p.locator('.view button:has-text("Stop")').first().click();
  await p.locator(".reject-dialog .reject-reason-input").fill("not worth more turns");
  const sresP = p.waitForResponse((r) => r.url().endsWith(`/tickets/${b.id}/stop`), {
    timeout: 10000,
  });
  await p.locator(".reject-dialog .reject-submit").click();
  const sres = await sresP.catch(() => null);
  const stopped = await L.waitStatus(b.id, ["cancelled"], 10000, 400);
  t.check(
    sres &&
      JSON.parse(sres.request().postData() || "{}").reason === "not worth more turns" &&
      stopped,
    `Stop (with a reason) abandoned paused #${b.number} → cancelled`,
    `Stop: ${sres && sres.status()} status=${(await L.ticketOf(b.id)).status}`,
  );

  // ── pause → banner → Continue → Poll resumes in the same worktree ─────────
  const a = await pause("Pause and continue");
  await t.visit(`ticket/${a.id}`);
  const banner = (await p.textContent(".paused-banner").catch(() => "")) || "";
  t.check(
    /hit the turn cap/.test(banner) && /999 turns/.test(banner) && /spend so far/.test(banner),
    `the ticket page's paused banner names the cap and the spend so far ("${banner.slice(0, 120)}")`,
    `paused banner reads '${banner}'`,
  );
  await L.shot(p, "s10-paused-banner");
  const resP = p.waitForResponse((r) => r.url().endsWith(`/tickets/${a.id}/continue`), {
    timeout: 10000,
  });
  await p.locator('.view button:has-text("Continue")').first().click();
  const cres = await resP.catch(() => null);
  const ctoast = await L.waitToast(p, /Continue requested/, 6000);
  t.check(
    cres && cres.status() < 300 && ctoast,
    "Continue posted /continue and said the factory will resume it",
    `Continue: ${cres && cres.status()} toast=${ctoast}`,
  );
  const ptoast = await t.poll();
  t.check(
    /Continuing the paused delivery/.test(ptoast),
    `Poll for work with only a resume pending says it is continuing the paused delivery ("${ptoast.slice(0, 60)}")`,
    `Poll toast after Continue: "${ptoast}"`,
  );
  const resumed = await L.waitStatus(
    a.id,
    ["in_review", "blocked", "refining", "cancelled"],
    240000,
  );
  const calls = L.stubCalls({ kind: "delivery", ticket: a.number });
  t.check(
    resumed?.status === "in_review" && calls.length === 2 && calls[1].cwd === calls[0].cwd,
    `the resumed delivery ran in the SAME worktree and landed in Review (#${a.number}, ${calls.length} agent calls)`,
    `resume: status=${resumed?.status} calls=${calls.length} same worktree=${calls[1] && calls[1].cwd === calls[0].cwd}`,
  );

  // Stop's worktree is reaped by the runner's cleanup on the next tick (the ones above).
  const gone = await L.maybe(
    async () => (wt && !existsSync(wt) ? true : null),
    "worktree removal",
    20000,
    1000,
  );
  t.check(
    gone,
    "the stopped delivery's worktree was reaped by the next tick's cleanup",
    `the stopped delivery's worktree is still on disk after the next tick: ${wt}`,
  );

  // ── caps a Poll honours, each lowered from Settings ───────────────────────
  const victim = await L.seedTicket(t, {
    title: `Cap victim (${L.tag("s10")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  const refusedPoll = async (key, value, re, what) => {
    // Put the setting back as it was, not blank: the world's daily budget is what
    // lets every later poll run (a live tick needs a dollar cap).
    const prev = L.readSettingsFile()[key] ?? "";
    await t.visit("settings");
    await t.setSetting(key, value);
    const sv = await t.saveSettings();
    if (!(sv.status < 300 && sv.sent[key] === value))
      t.bad(`Settings: ${key}=${value} not saved (${sv.status} ${JSON.stringify(sv.sent)})`);
    const before = L.stubCalls({ kind: "delivery", ticket: victim.number }).length;
    await t.visit("work");
    await t.poll();
    const toast = await L.waitToast(p, /Poll refused/, 15000);
    await L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "refused run to end",
      30000,
      1000,
    );
    const after = L.stubCalls({ kind: "delivery", ticket: victim.number }).length;
    const st = (await L.ticketOf(victim.id)).status;
    t.check(
      toast && re.test(toast) && after === before && st === "ready",
      `${what}: Poll refused with the runner's reason ("${(toast || "").slice(0, 110)}") — no agent launched, #${victim.number} still ready`,
      `${what}: toast=${toast} agent calls ${before}→${after} status=${st}`,
    );
    await t.visit("settings");
    await t.setSetting(key, prev);
    await t.saveSettings();
  };
  await refusedPoll(
    "MAX_TICKS_PER_DAY",
    "1",
    /per-day cap \(MAX_TICKS_PER_DAY=1/,
    "per-day tick cap lowered to 1",
  );
  await refusedPoll(
    "GAFFER_DAILY_BUDGET_USD",
    "0.01",
    /per-day USD cap/,
    "per-day USD cap below today's spend",
  );
  await refusedPoll(
    "GAFFER_BUDGET_USD",
    "0.01",
    /lifetime budget/,
    "lifetime budget below what was spent",
  );

  // ── an empty queue, idle loops off: nothing to do ─────────────────────────
  await L.api("POST", `/tickets/${victim.id}/wont-do`, { reason: "empty-queue check" });
  const runsBefore = ((await L.api("GET", "/api/runs")).json.recent || []).length;
  await t.visit("work");
  const etoast = await t.poll();
  const runsAfter = ((await L.api("GET", "/api/runs")).json.recent || []).length;
  t.check(
    /Nothing for a tick to do/.test(etoast) && runsAfter === runsBefore,
    `an empty queue with the idle loops off: Poll says there is nothing to do and starts no run ("${etoast.slice(0, 70)}")`,
    `empty-queue Poll: toast="${etoast}" runs ${runsBefore}→${runsAfter}`,
  );
}
