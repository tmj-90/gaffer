/* global document, window, getComputedStyle, location */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// S19 layout, keyboard and contrast with a busy world (exploratory findings
// ui-explore/F-02, F-06, F-08 to F-14). The world holds what broke the pages: a live
// claim (the Work board's On-the-pitch table), an agent with a 39-character name (the
// Match report), a 200-character title (a board card), a delivered ticket in review
// (the verdict strip's gates) and one approved and waiting for Merge now (its card's
// long status). Then:
//   - every view at 375, 768, 1280 and 1920 is no wider than the viewport, no board
//     card's content runs past its edge, and a long title is clamped with the full
//     title on its link;
//   - the Search palette keeps focus inside it and Esc closes it wherever focus is;
//   - the header's More menu closes when keyboard focus leaves it, and a mouse click
//     on an item still lands where the click gives it no focus (Safari);
//   - Tab on the Floor walks the stations in lifecycle order;
//   - a `.btn-link` is no native grey button and reads at 4.5:1 in both kits;
//   - the Health flow strip is a list of links (no role=listitem on a link);
//   - a passing gate's note is not red and a gate's note never breaks mid-word.
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

/** Relative luminance contrast of two rgb() strings (alpha ignored). */
function contrast(a, b) {
  const lum = (s) => {
    const [r, g, bl] = (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

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
    // ...and still works with a mouse where a clicked link takes no focus (Safari): its
    // mousedown blurs the item focused on open, which must not close the menu before the
    // click lands (review follow-up).
    await p.evaluate(() =>
      document.addEventListener(
        "mousedown",
        (e) => {
          if (e.target.closest?.(".nav-menu a, .nav-menu button")) {
            e.preventDefault();
            document.activeElement?.blur();
          }
        },
        true,
      ),
    );
    await more.click();
    await p.waitForSelector(".nav-menu a", { timeout: 3000 }).catch(() => null);
    const pick = p.locator(".nav-menu a").last();
    const href = await pick.getAttribute("href").catch(() => null);
    await pick.click().catch(() => null);
    await L.sleep(600);
    const went = await p.evaluate(() => location.hash);
    t.check(
      href && went === href,
      `a mouse click on a More item navigates even when the click gives it no focus (${href})`,
      `More by mouse, Safari-style focus: wanted ${href}, at ${went}`,
    );
    await p.reload({ waitUntil: "load" });
    await L.sleep(600);
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

  // ── .btn-link in both kits (F-08) ──────────────────────────────────────────
  const btnLink = [];
  for (const scheme of ["light", "dark"]) {
    const pg = await L.openPage(t.browser, { width: 1280, height: 800 });
    await pg.emulateMedia({ colorScheme: scheme });
    await pg.goto(`${L.BASE}/#/overview`, { waitUntil: "load" });
    await L.sleep(900);
    const st = await pg.evaluate(() => {
      // A sentence on a programme page, where the Cup runs' "Plan a build" sits.
      const host =
        document.querySelector(".prog.campaigns p") ||
        document.querySelector("#app .card p.quiet, #app .card p");
      const b = document.createElement("button");
      b.className = "btn-link";
      b.textContent = "Plan a build";
      host.appendChild(b);
      const cs = getComputedStyle(b);
      let n = b;
      let bg = "rgba(0, 0, 0, 0)";
      while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
        bg = getComputedStyle(n).backgroundColor;
        n = n.parentElement;
      }
      const out = { own: cs.backgroundColor, color: cs.color, bg };
      b.remove();
      return out;
    });
    btnLink.push({ scheme, ...st, ratio: contrast(st.color, st.bg) });
    await pg.context().close();
  }
  t.check(
    btnLink.every((b) => /rgba\(0, 0, 0, 0\)|transparent/.test(b.own) && b.ratio >= 4.5),
    `a .btn-link has no button face and reads at ${btnLink.map((b) => `${b.ratio.toFixed(1)}:1 (${b.scheme})`).join(", ")}`,
    `.btn-link: ${btnLink.map((b) => `${b.scheme} face ${b.own}, text ${b.color} on ${b.bg} = ${b.ratio.toFixed(2)}:1`).join("; ")}`,
  );

  // ── Health: the flow strip is a list of links (F-09) ───────────────────────
  await p.goto(`${L.BASE}/#/health`, { waitUntil: "load" });
  await p.waitForSelector(".pipeline", { timeout: 15000 }).catch(() => null);
  await L.sleep(600);
  const flow = await p.evaluate(() => {
    const strip = document.querySelector(".pipeline");
    return {
      tag: strip?.tagName,
      roleOnLinks: document.querySelectorAll("a[role=listitem]").length,
      items: strip ? strip.querySelectorAll(":scope > li > a").length : 0,
    };
  });
  t.check(
    flow.roleOnLinks === 0 && /^(OL|UL)$/.test(flow.tag || "") && flow.items > 0,
    `the Health flow strip is a <${(flow.tag || "").toLowerCase()}> of ${flow.items} <li><a>, no link carries role=listitem`,
    `Health flow strip: <${flow.tag}> with ${flow.items} li>a, ${flow.roleOnLinks} link(s) with role=listitem`,
  );

  // ── Review: gate notes (F-13) ──────────────────────────────────────────────
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.goto(`${L.BASE}/#/review/${w.review.id}`, { waitUntil: "load" });
  await p.waitForSelector(".vd-gate, .dod-item", { timeout: 20000 }).catch(() => null);
  await L.sleep(1200);
  const gates = await p.evaluate(() => {
    const red = getComputedStyle(document.documentElement).getPropertyValue("--red").trim();
    const probe = document.createElement("span");
    probe.style.color = red || "red";
    document.body.appendChild(probe);
    const redRgb = getComputedStyle(probe).color;
    probe.remove();
    const passNotes = [...document.querySelectorAll(".dod-note-pass")].map(
      (n) => getComputedStyle(n).color,
    );
    // A note squeezed into a column a few characters wide wraps every few letters.
    const narrow = [...document.querySelectorAll(".vd-cmd, .vd-note")]
      .filter((n) => n.getBoundingClientRect().width > 0)
      .filter((n) => n.getBoundingClientRect().width < 120 && n.textContent.length > 12)
      .map(
        (n) => `${n.textContent.slice(0, 30)} (${Math.round(n.getBoundingClientRect().width)}px)`,
      );
    return { redRgb, passNotes, narrow, rows: document.querySelectorAll(".vd-gate").length };
  });
  t.check(
    gates.rows > 0 && gates.narrow.length === 0 && gates.passNotes.every((c) => c !== gates.redRgb),
    `the sign-off's ${gates.rows} gate rows give each note room (none squeezed), and a passing gate's note is not red (${gates.passNotes.length} checked)`,
    `gate notes: squeezed=${gates.narrow.join(" | ")} pass-note colours=${gates.passNotes.join(",")} (red ${gates.redRgb}) rows=${gates.rows}`,
  );
  await L.shot(p, "s19-review-gates");
  await p.context().close();
  await revokeHeld(L, w);
}
