/* global document, window, getComputedStyle */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// S19 layout with a busy world (exploratory findings
// ui-explore/F-02, F-10 and F-14). The world holds what broke the pages: a live
// claim (the Work board's On-the-pitch table), an agent with a 39-character name (the
// Match report), a 200-character title (a board card), a delivered ticket in review
// (the verdict strip's gates) and one approved and waiting for Merge now (its card's
// long status). Then:
//   - every view at 375, 768, 1280 and 1920 is no wider than the viewport, no board
//     card's content runs past its edge, and a long title is clamped with the full
//     title on its link.
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

  await L.shot(p, "s19-review-gates");
  await p.context().close();
  await revokeHeld(L, w);
}
