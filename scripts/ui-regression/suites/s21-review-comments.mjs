// S21 review comments, Fix these and since your review (Release A: A1, A2, A3). A
// delivered ticket gets a must-fix comment on one of its diff lines from the Review view
// (the + beside the line); the thread shows under the line and "Open comments: 1 (1
// must-fix)" joins the flags list. Fix these (1) names the server's outcome and sends it
// back to Refining with that comment as a numbered requirement. Once readied, the next
// delivery's prompt lists the requirement inside its untrusted envelope. The Review view
// of that attempt opens on "Changes since your review" (the interdiff from the commit
// sent back), the comment carries its git anchor tag, Approve stays live for the whole
// change, and Resolve marks the comment resolved.
export default async function s21(t, L) {
  const p = t.page;
  const BODY = `Name the helper after what it keeps (${L.tag("s21")})`;

  const tk = await L.seedTicket(t, {
    title: `Review comments ticket (${L.tag("s21")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const first = await L.waitStatus(tk.id, L.SETTLED, 240000);
  if (first?.status !== "in_review") {
    t.bad(`delivery ended in '${first?.status}' · ${await L.whyStuck(tk, t.lastPoll)}`);
    return;
  }

  // ── a line comment from the Review view ─────────────────────────────────────
  await t.visit(`review/${tk.id}`, { label: "review/:id" });
  const row = p.locator(".diff-line", { hasText: `export function helper${tk.number}` }).first();
  await row.waitFor({ timeout: 20000 });
  await row.hover();
  await row.locator("button.diff-cmt").click();
  await p.locator(".rc-composer textarea").fill(BODY);
  const postP = p.waitForResponse(
    (r) => /\/review\/comments$/.test(r.url()) && r.request().method() === "POST",
    { timeout: 15000 },
  );
  await p.locator('.rc-composer button[type="submit"]').click();
  const post = await postP.catch(() => null);
  const sent = post ? JSON.parse(post.request().postData() || "{}") : {};
  t.check(
    post &&
      post.status() === 201 &&
      sent.severity === "must_fix" &&
      sent.path === "src/tasks.js" &&
      Number.isInteger(sent.line) &&
      /^[0-9a-f]{40}$/.test(sent.commit || ""),
    "the + beside a diff line posts a must-fix comment anchored to its file, line and the head shown",
    `comment post: ${post && post.status()} ${JSON.stringify(sent)}`,
  );
  const thread = await L.maybe(
    async () => ((await p.textContent(".rc-thread").catch(() => "")) || "").includes(BODY),
    "thread",
    10000,
    300,
  );
  const flags = (await p.textContent(".flag-list").catch(() => "")) || "";
  t.check(
    thread && /Open comments: 1 \(1 must-fix\)/.test(flags),
    "the comment's thread shows under its line, and the flags list says Open comments: 1 (1 must-fix)",
    `thread=${thread} flags='${flags.slice(0, 200)}'`,
  );
  await L.shot(p, "s21-comment-thread");

  // ── Fix these sends it back with the comment as a requirement ─────────────
  const fixBtn = p.locator("button.fix-these");
  const label = (await fixBtn.textContent().catch(() => "")) || "";
  t.check(
    /Fix these \(1\)/.test(label) && (await fixBtn.isEnabled()),
    "Fix these (1) is live beside Send back, named by the server's outcome",
    `Fix these button: '${label}' enabled=${await fixBtn.isEnabled().catch(() => false)}`,
  );
  await fixBtn.click();
  const fixP = p.waitForResponse((r) => /\/review\/fix$/.test(r.url()), { timeout: 15000 });
  await p.locator(".confirm-submit").click();
  const fix = await fixP.catch(() => null);
  const fixBody = fix ? await fix.json().catch(() => ({})) : {};
  t.check(
    fix &&
      fix.status() === 200 &&
      fixBody.reject_outcome?.kind === "to_refining" &&
      fixBody.ticket?.status === "refining",
    "Fix these sent the ticket back to Refining, and the response says so (reject_outcome to_refining)",
    `fix: ${fix && fix.status()} ${JSON.stringify(fixBody).slice(0, 240)}`,
  );
  const events = (await L.ticketView(tk.id)).events || [];
  const reason = events
    .filter((e) => e.event_type === "ticket.transitioned")
    .map((e) => JSON.parse(e.payload_json || "{}").reason)
    .pop();
  t.check(
    /^Fix these: 1 requirement \([0-9a-f]{8}\)$/.test(reason || ""),
    `the send-back's reason is the deterministic sentence ("${reason}")`,
    `the send-back's reason: '${reason}'`,
  );

  // ── the next attempt sees the requirement ─────────────────────────────────
  const ready = await L.api("POST", `/tickets/${tk.id}/ready`);
  t.check(ready.status < 300, "the human readies it again from Refining", `ready: ${ready.status}`);
  await t.visit("work");
  await t.poll();
  const second = await L.waitStatus(tk.id, L.SETTLED, 240000);
  if (second?.status !== "in_review") {
    t.bad(`redelivery ended in '${second?.status}' · ${await L.whyStuck(tk, t.lastPoll)}`);
    return;
  }
  const calls = L.stubCalls({ kind: "delivery", ticket: tk.number });
  const prompt = (calls[calls.length - 1] || {}).prompt || "";
  const env = (prompt.match(
    /<untrusted-review-requirements>[\s\S]*?<\/untrusted-review-requirements>/,
  ) || [""])[0];
  t.check(
    /REVIEW REQUIREMENTS/.test(prompt) && env.includes(BODY) && /src\/tasks\.js:\d+/.test(env),
    "the next delivery prompt lists the comment as a numbered requirement (repo:path:line, its body) inside its untrusted envelope",
    `redelivery prompt requirements: '${env.slice(0, 240) || "(no envelope)"}'`,
  );

  // ── since your review ─────────────────────────────────────────────────────
  await t.visit(`review/${tk.id}`, { label: "review/:id" });
  const bar = await L.maybe(
    async () => {
      const txt = (await p.textContent(".since-bar").catch(() => "")) || "";
      return /Changes since your review/.test(txt) ? txt : null;
    },
    "since bar",
    20000,
    400,
  );
  const sinceShown = await p
    .locator('.since-bar button[data-since="1"][aria-pressed="true"]')
    .count()
    .catch(() => 0);
  const sinceDiff = (await p.textContent(".since-box").catch(() => "")) || "";
  t.check(
    bar && sinceShown === 1 && /revisited/.test(sinceDiff),
    "the next attempt opens on Changes since your review: the interdiff from the commit sent back",
    `since bar='${(bar || "").slice(0, 160)}' pressed=${sinceShown} box='${sinceDiff.slice(0, 160)}'`,
  );
  const item = p.locator(".rv-comments .rc-item", { hasText: BODY }).first();
  const tagged = await L.maybe(
    async () => {
      const txt = (await item.textContent().catch(() => "")) || "";
      return /anchor (changed in this revision|untouched)/.test(txt) ? txt : null;
    },
    "anchor tag",
    15000,
    400,
  );
  t.check(
    tagged,
    "the earlier comment carries its git anchor tag (changed in this revision / untouched)",
    "the earlier comment has no anchor tag",
  );
  const approveLive = await p
    .locator(".signoff-btn")
    .isEnabled()
    .catch(() => false);
  t.check(
    approveLive,
    "Approve stays live for the whole change while the interdiff is shown",
    "Approve is off on the since-review view",
  );
  await L.shot(p, "s21-since-review");

  // ── Resolve is the reviewer's act ─────────────────────────────────────────
  const resP = p.waitForResponse((r) => /\/resolve$/.test(r.url()), { timeout: 15000 });
  await item.locator('button[data-comment-act="resolve"]').click();
  const res = await resP.catch(() => null);
  const after =
    ((await L.api("GET", `/tickets/${tk.id}/review/comments`)).json || {}).comments || [];
  t.check(
    res && res.status() === 200 && after.some((c) => c.body === BODY && c.status === "resolved"),
    "Resolve marks the comment resolved",
    `resolve: ${res && res.status()} ${JSON.stringify(after.map((c) => c.status))}`,
  );
}
