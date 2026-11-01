/* global document, window, getComputedStyle */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// S19 layout and keyboard with a busy world (exploratory findings
// ui-explore/F-02, F-06, F-10 to F-12 and F-14). The world holds what broke the pages: a live
// claim (the Work board's On-the-pitch table), an agent with a 39-character name (the
// Match report), a 200-character title (a board card), a delivered ticket in review
// (the verdict strip's gates) and one approved and waiting for Merge now (its card's
// long status). Then:
//   - every view at 375, 768, 1280 and 1920 is no wider than the viewport, no board
//     card's content runs past its edge, and a long title is clamped with the full
//     title on its link;
//   - the Search palette keeps focus inside it and Esc closes it wherever focus is;
//   - the header's More menu closes when keyboard focus leaves it;
//   - Tab on the Floor walks the stations in lifecycle order.
import { revokeHeld, seedWorld } from "./s18-read-only.mjs";

const VIEWS = (w, t) =>
  [
    ["overview", "overview"],
    ["work", "work"],
    ["work?mode=list", "work list"],
    [`review/${w.review.id}`, "review/:id"],
    [`ticket/${w.held.id}`, "ticket"],
    ["epics", "epics"],
    w.epicId ? [`epics/${w.epicId}`, "epics/:id"] : null,
    ["create", "create"],
    ["factory", "map"],
    ["specs", "specs"],
    ["memory", "memory"],
    ["squad", "squad"],
    ["floor", "floor"],
    ["health", "health"],
    ["settings", "settings"],
    [`repo/${encodeURIComponent(t.repo.id)}`, "repo/:id"],
  ].filter(Boolean);

export default async function s19(t, L) {
  const w = await seedWorld(t, L, "s19", { approved: true });
  const mst = w.toMerge && w.toMerge.status;
  t.check(
    w.review.status === "in_review" && w.claim.claimToken && mst === "ready_for_merge",
    `seeded: #${w.review.number} in review, #${w.held.number} claimed by '${w.agent.display_name}' (200-char title), #${w.toMerge.number} approved and waiting to merge`,
    `seed: review=${w.review.status} claim=${Boolean(w.claim.claimToken)} approved=${mst}`,
  );

  // ── the sweep: four widths, every view ────────────────────────────────────
  for (const [vw, vh] of [
    [375, 812],
    [768, 1024],
    [1280, 800],
    [1920, 1080],
  ]) {
    const pg = await L.openPage(t.browser, { width: vw, height: vh });
    const problems = [];
    for (const [route, label] of VIEWS(w, t)) {
      await pg.goto(`${L.BASE}/#/${route}`, { waitUntil: "load" });
      await pg
        .waitForFunction(
          () => (document.querySelector("#app")?.textContent || "").trim().length > 50,
          null,
          { timeout: 15000 },
        )
        .catch(() => null);
      await L.sleep(900);
      problems.push(...(await L.layoutProblems(pg, label)));
      const m = await pg.evaluate((heldId) => {
        const over = [...document.querySelectorAll(".board-card")]
          .filter((c) => c.getBoundingClientRect().width > 0 && c.scrollWidth > c.clientWidth + 1)
          .map(
            (c) =>
              `${c.querySelector(".num")?.textContent || "?"} (+${c.scrollWidth - c.clientWidth}px)`,
          );
        const card = document.querySelector(`.board-card[data-id="${heldId}"]`);
        const title = card && card.querySelector(".card-title");
        const lh = title ? parseFloat(getComputedStyle(title).lineHeight) || 18 : 0;
        return {
          over,
          titleLines:
            title && title.getBoundingClientRect().height
              ? Math.round(title.getBoundingClientRect().height / lh)
              : null,
          titleAttr: card ? card.querySelector(".card-link")?.getAttribute("title") || "" : null,
          claimsInBox: (() => {
            const tb = document.querySelector(".claims-table");
            if (!tb || !tb.getBoundingClientRect().width) return null;
            const box = tb.parentElement;
            return (
              getComputedStyle(box).overflowX === "auto" &&
              box.getBoundingClientRect().right <= window.innerWidth + 1
            );
          })(),
        };
      }, w.held.id);
      if (m.over.length)
        problems.push(`${label}@${vw} card content past its edge: ${m.over.join(", ")}`);
      if (m.titleLines != null && m.titleLines > 3)
        problems.push(`${label}@${vw} the 200-char title is ${m.titleLines} lines on its card`);
      if (
        m.titleAttr != null &&
        m.titleLines != null &&
        !m.titleAttr.includes("with a very long title")
      )
        problems.push(`${label}@${vw} the clamped title's link has no title attribute`);
      if (m.claimsInBox === false)
        problems.push(`${label}@${vw} the claims table has no scroll box of its own`);
    }
    problems.length
      ? t.bad(
          `layout @${vw}px with a live claim, a long name and a long title: ${problems.join("; ").slice(0, 1200)}`,
        )
      : t.ok(
          `layout @${vw}px: ${VIEWS(w, t).length} views fit with a live claim, a 39-char agent name and a 200-char title (no sideways scroll, cards hold their content, the title clamps to 3 lines)`,
        );
    if (vw === 375) await L.shot(pg, "s19-work-375");
    await pg.context().close();
  }

  const p = await L.openPage(t.browser, { width: 1000, height: 900 });

  // ── the Search palette keeps focus and closes on Esc (F-06) ──────────────
  await p.goto(`${L.BASE}/#/overview`, { waitUntil: "load" });
  await L.sleep(900);
  await p.keyboard.press("Control+k");
  await p.waitForSelector(".palette-scrim.open", { timeout: 5000 }).catch(() => null);
  await L.sleep(400);
  const inside = [];
  for (let i = 0; i < 4; i++) {
    await p.keyboard.press("Tab");
    inside.push(await p.evaluate(() => Boolean(document.activeElement?.closest(".palette"))));
  }
  // Focus the list itself (a click on its scroll bar does), then Esc.
  await p.evaluate(() => document.querySelector(".palette-list")?.focus());
  await p.keyboard.press("Escape");
  const closed = await p.evaluate(() => !document.querySelector(".palette-scrim.open"));
  t.check(
    inside.every(Boolean) && closed,
    "the Search palette keeps focus inside it on Tab, and Esc closes it with focus on its list",
    `palette: focus inside after each Tab=${inside.join(",")} closed by Esc from the list=${closed}`,
  );

  // ── the More menu closes when focus leaves it (F-11) ──────────────────────
  await p.reload({ waitUntil: "load" }); // a palette left open must not cover the header
  await L.sleep(900);
  const more = p.locator(".nav-more");
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await p.waitForSelector(".nav-menu", { timeout: 3000 }).catch(() => null);
    const items = await p.locator(".nav-menu a, .nav-menu button").count();
    for (let i = 0; i < items + 3; i++) await p.keyboard.press("Tab");
    await L.sleep(200);
    const stillOpen = await p.locator(".nav-menu").count();
    t.check(
      stillOpen === 0,
      `the More menu closes once Tab takes focus out of it (${items} items, Tab x${items + 3})`,
      "the More menu stayed drawn after keyboard focus left it",
    );
  } else t.skip("More menu: the header is not folded at 1000px in this world");

  // ── Floor: Tab follows the stations (F-12) ─────────────────────────────────
  await p.goto(`${L.BASE}/#/floor`, { waitUntil: "load" });
  await p.waitForSelector("svg.fl-svg a.fl-hit", { timeout: 15000 }).catch(() => null);
  await L.sleep(1200);
  const seq = [];
  await p.evaluate(() => {
    const a = document.querySelector(".view-floor h1, .view-floor .view-head");
    if (a) {
      a.setAttribute("tabindex", "-1");
      a.focus();
    }
  });
  for (let i = 0; i < 60; i++) {
    await p.keyboard.press("Tab");
    const at = await p.evaluate(() => {
      const a = document.activeElement;
      if (!a || !a.closest?.("svg.fl-svg")) return null;
      return a.getAttribute("data-station") || `t:${a.getAttribute("data-status")}`;
    });
    if (at) seq.push(at);
    else if (seq.length) break;
  }
  const STATION = {
    draft: "drawing",
    refining: "drawing",
    ready: "stores",
    claimed: "assembly",
    in_progress: "assembly",
    in_review: "inspection",
    in_testing: "testrig",
    ready_for_merge: "loading",
    done: "despatch",
    blocked: "jam",
    paused: "jam",
    failed: "jam",
  };
  const ORDER = [
    "drawing",
    "stores",
    "assembly",
    "inspection",
    "testrig",
    "loading",
    "despatch",
    "jam",
    "desk",
  ];
  const ranks = seq.map((s) =>
    ORDER.indexOf(s.startsWith("t:") ? STATION[s.slice(2)] || "desk" : s),
  );
  const sorted = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
  t.check(
    seq.length > 3 && sorted,
    `Tab on the Floor walks ${seq.length} stops in station order (${[...new Set(seq.map((s) => s.replace(/^t:/, "#")))].join(" → ").slice(0, 160)})`,
    `Floor Tab order: ${seq.join(" → ").slice(0, 400)}`,
  );

  await L.shot(p, "s19-review-gates");
  await p.context().close();
  await revokeHeld(L, w);
}
