// The Tactics Board: the pitch.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentWho } from "../access.js";
import { el, prefersReducedMotion } from "../dom.js";
import { fmtTime, money } from "../format.js";
import { agentShirt, kitShirt, ycard } from "../icons.js";
import {
  ARROW_WINDOW_MS,
  OFF_PITCH,
  ON_BENCH,
  ON_PITCH,
  PITCH_MAX_CHANNELS,
  PITCH_ZONES,
  pitchBall,
  shirtGroup,
  svgS,
  textWidth,
  wrapLabel,
} from "../matchday.js";
import { appState } from "../state.js";
import { statusBadge, statusLabel } from "../status.js";

// --- The Tactics Board -------------------------------------------------------

/**
 * Which repos get a channel: those with tickets in play or done. The busiest get
 * a channel (in play counts most); the channels then run from the wing with the
 * club's biggest squad (most tickets) to the smallest, as the comp draws them, so
 * a repo keeps its channel while its tickets move.
 */
function pitchChannels(f) {
  const score = new Map();
  const size = new Map();
  for (const t of f.tickets) {
    const r = f.repoOf.get(t.id);
    if (!r || t.status === "cancelled") continue;
    size.set(r, (size.get(r) || 0) + 1);
    if (ON_PITCH.has(t.status)) score.set(r, (score.get(r) || 0) + 10);
    else if (t.status === "done") score.set(r, (score.get(r) || 0) + 1);
  }
  const bySize = (a, b) => size.get(b) - size.get(a) || a.localeCompare(b);
  const all = [...score.keys()].sort((a, b) => score.get(b) - score.get(a) || a.localeCompare(b));
  if (all.length <= PITCH_MAX_CHANNELS) return { channels: all.sort(bySize), other: null };
  const keep = all.slice(0, PITCH_MAX_CHANNELS - 1).sort(bySize);
  return { channels: [...keep, "Other repos"], other: new Set(all.slice(PITCH_MAX_CHANNELS - 1)) };
}

/** The window the chalk arrows cover: the last 3 hours, or the 3 before the last move. */
function arrowWindow(f) {
  let last = 0;
  for (const e of f.events) {
    if (e.event_type === "ticket.transitioned")
      last = Math.max(last, Date.parse(e.created_at) || 0);
  }
  const recent = last && f.now - last < ARROW_WINDOW_MS;
  const end = recent || !last ? f.now : last;
  return { start: end - ARROW_WINDOW_MS, end, recent: recent || !last };
}

/**
 * The tactics board drawing (ported from the approved comp's layout engine).
 * x is the lifecycle stage, y the repo channel. Every label keeps a pixel floor
 * at the size it is seen (k = viewBox units per CSS px); tags and arrows are laid
 * out at those sizes, so nothing collides.
 */
const PITCH_VW = { landscape: 14 + 1050 + 104, portrait: 14 + 680 + 14 };
function pitchBoard(f, orientation, k = orientation === "portrait" ? 2 : 1.26) {
  const P = orientation === "portrait";
  const { channels, other } = pitchChannels(f);
  const chanOf = (t) => {
    const r = f.repoOf.get(t.id);
    if (!r) return null;
    if (other && other.has(r)) return "Other repos";
    return channels.includes(r) ? r : null;
  };
  const NC = Math.max(1, channels.length);
  const L = 1050,
    W = 680,
    CH = W / NC;
  const fz = (design, floor = 12.5) => Math.max(design, floor * k);
  // Portrait leaves room under the kits for each channel's repo name (2 lines).
  const M = P
    ? { l: 14, t: 124, r: 14, b: 70 + Math.ceil(2 * fz(17) * 1.15) + 6 }
    : { l: 14, t: 58, r: 104, b: 14 };
  const VW = P ? M.l + W + M.r : M.l + L + M.r,
    VH = P ? M.t + L + M.b : M.t + W + M.b;
  const T = (px, py) => (P ? [M.l + py, M.t + (L - px)] : [M.l + px, M.t + py]);
  const R = P ? 25 : 19,
    SH = P ? 56 : 46;
  const pxs = (n) => ({ fontSize: n.toFixed(2) + "px" });
  const FS = {
    zl: fz(P ? 24 : 18, 12.5),
    cl: fz(17, 12.5),
    disc: fz(P ? 28 : 22, 14),
    tally: fz(P ? 28 : 22, 14),
    tag: fz(P ? 26 : 16, 13),
    shirt: fz(P ? 22 : 17, 12.5),
  };
  const rect = (x0, y0, x1, y1, a) => {
    const [ax, ay] = T(x0, y0),
      [bx, by] = T(x1, y1);
    return svgS("rect", {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
      ...a,
    });
  };
  const line = (x0, y0, x1, y1, a) => {
    const [ax, ay] = T(x0, y0),
      [bx, by] = T(x1, y1);
    return svgS("line", { x1: ax, y1: ay, x2: bx, y2: by, ...a });
  };
  const arc = (cx, cy, r, a0, a1, a) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = a0 + ((a1 - a0) * i) / 40;
      pts.push(T(cx + r * Math.cos(t), cy + r * Math.sin(t)).join(","));
    }
    return svgS("polyline", { points: pts.join(" "), fill: "none", ...a });
  };
  const obs = [];
  const box = (x0, y0, x1, y1, why) => {
    const b = { x0, y0, x1, y1, why };
    obs.push(b);
    return b;
  };
  const tid = `pitch-t-${orientation}-${++appState.svgUid}`;
  const svg = svgS(
    "svg",
    {
      viewBox: `0 0 ${VW} ${VH}`,
      class: `pitch pitch-${orientation}`,
      role: "group",
      "aria-labelledby": tid,
    },
    svgS(
      "title",
      { id: tid },
      "Tactics board: every ticket in play, placed by stage (towards goal) and repo (channel). Agents are the shirts.",
    ),
  );
  const turf = svgS("g", { class: "turf" });
  PITCH_ZONES.forEach((z, i) =>
    turf.append(rect(z.x0, 0, z.x1, W, { class: i % 2 ? "mow-b" : "mow-a" })),
  );
  svg.append(turf);
  const chalk = svgS("g", { class: "chalk" });
  chalk.append(
    rect(0, 0, L, W, { fill: "none" }),
    line(525, 0, 525, W),
    arc(525, 340, 91.5, 0, Math.PI * 2),
    rect(0, 138.4, 165, 541.6, { fill: "none" }),
    rect(885, 138.4, 1050, 541.6, { fill: "none" }),
    rect(0, 248.4, 55, 431.6, { fill: "none" }),
    rect(995, 248.4, 1050, 431.6, { fill: "none" }),
    arc(110, 340, 91.5, -0.93, 0.93),
    arc(940, 340, 91.5, Math.PI - 0.93, Math.PI + 0.93),
  );
  for (const cx of [110, 525, 940]) {
    const [x, y] = T(cx, 340);
    chalk.append(svgS("circle", { cx: x, cy: y, r: 3.5, class: "spot" }));
  }
  chalk.append(rect(1050, 303.4, 1078, 376.6, { class: "goal" }));
  for (let j = 0; j < 6; j++)
    chalk.append(line(1050 + j * 5, 303.4, 1050 + j * 5, 376.6, { class: "net" }));
  svg.append(chalk);
  const guides = svgS("g", { class: "guides" });
  for (let c = 1; c < NC; c++) guides.append(line(0, c * CH, L, c * CH, { class: "lane-guide" }));
  svg.append(guides);

  const labels = svgS("g", { class: "zone-labels", "aria-hidden": "true" });
  for (const z of PITCH_ZONES) {
    const mid = (z.x0 + z.x1) / 2,
      w = textWidth(z.label, FS.zl, 0.1);
    if (P) {
      // The stage name sits in the band's corner; when the first channel has
      // players there it moves to the far corner, so no shirt covers it.
      const busy = (r) => f.tickets.some((t) => t.status === z.key && chanOf(t) === r);
      const right = busy(channels[0]) && !busy(channels[channels.length - 1]);
      const [x0, y] = T(z.x1, 0),
        [x1] = T(z.x1, W);
      labels.append(
        svgS(
          "text",
          {
            x: right ? x1 - 8 : x0 + 8,
            y: y + 8 + FS.zl,
            "text-anchor": right ? "end" : null,
            class: `zl ${PITCH_ZONES.indexOf(z) % 2 ? "halo-b" : "halo-a"}`,
            style: pxs(FS.zl),
          },
          z.label,
        ),
      );
      if (right) box(x1 - 12 - w, y + 4, x1 - 4, y + 14 + FS.zl, "zl");
      else box(x0 + 4, y + 4, x0 + 12 + w, y + 14 + FS.zl, "zl");
    } else {
      const [x, y] = T(mid, 0);
      labels.append(
        svgS(
          "text",
          { x, y: y - 16, "text-anchor": "middle", class: "zl", style: pxs(FS.zl) },
          z.label,
        ),
      );
    }
  }
  {
    const [gx, gy] = P ? T(L, W / 2) : T(L, 0);
    const cx = P ? gx : gx + 52,
      by = P ? 8 : gy - 46,
      h = FS.zl + 14,
      w = textWidth("DONE", FS.zl, 0.08) + 22;
    labels.append(
      svgS("rect", { x: cx - w / 2, y: by, width: w, height: h, rx: 3, class: "zl-plaque" }),
      svgS(
        "text",
        {
          x: cx,
          y: by + h / 2 + FS.zl * 0.36,
          "text-anchor": "middle",
          class: "zl zl-goal",
          style: pxs(FS.zl),
        },
        "Done",
      ),
    );
    box(cx - w / 2, by, cx + w / 2, by + h, "done");
  }
  const kits = svgS("g", { class: "channel-kits", "aria-hidden": "true" });
  channels.forEach((r, c) => {
    const ks = P ? 40 : 30,
      kt = kitShirt(r, ks);
    const [x, y] = P ? T(0, (c + 0.5) * CH) : T(8, c * CH + 8);
    const kx = P ? x - 20 : x,
      ky = P ? y + 14 : y;
    kt.setAttribute("x", kx);
    kt.setAttribute("y", ky);
    kt.classList.add("kit-chalk");
    kits.append(kt);
    box(kx, ky, kx + ks, ky + ks, "kit");
    if (P) {
      // A phone has no room beside the kit: the name sits under it, wrapped.
      const lines = wrapLabel(r, FS.cl, CH - 10, 2, "text");
      lines.forEach((ln, i) =>
        kits.append(
          svgS(
            "text",
            {
              x,
              y: ky + ks + 6 + FS.cl * (0.9 + i * 1.15),
              "text-anchor": "middle",
              class: "cl cl-p",
              style: pxs(FS.cl),
            },
            ln,
          ),
        ),
      );
    } else {
      // A turf patch under the name, so a chalk line it sits on (the box's
      // edge) never strikes it through.
      const by = y + 15 + FS.cl * 0.4,
        [zx] = T(PITCH_ZONES[0].x1, 0);
      kits.append(
        svgS("rect", {
          x: x + 33,
          y: by - FS.cl * 0.82,
          width: Math.max(0, Math.min(textWidth(r, FS.cl, 0, "text") + 6, zx - x - 33)),
          height: FS.cl * 1.08,
          class: "mow-a",
        }),
        svgS("text", { x: x + 36, y: by, class: "cl halo-a", style: pxs(FS.cl) }, r),
      );
      box(x + 34, y + 2, x + 38 + textWidth(r, FS.cl, 0, "text"), y + 22 + FS.cl * 0.4, "cl");
    }
  });

  const cells = new Map();
  const inPlay = f.tickets.filter((t) => ON_PITCH.has(t.status) && chanOf(t));
  for (const t of inPlay.sort((a, b) => (a.number || 0) - (b.number || 0))) {
    const key = t.status + "|" + chanOf(t);
    (cells.get(key) || cells.set(key, []).get(key)).push(t);
  }
  const claimOf = (t) => f.claimByTicket.get(t.id);
  const pos = new Map();
  for (const [key, list] of cells) {
    const [st, repo] = key.split("|");
    const z = PITCH_ZONES.find((x) => x.key === st),
      c = channels.indexOf(repo);
    const withAgent = list.some((t) => claimOf(t));
    // A crowded cell packs tighter, then wraps into a second row.
    const zoneW = z.x1 - z.x0;
    const step0 = withAgent ? SH + (P ? 30 : 24) : 2.2 * R + (P ? 4 : 10);
    // A phone's channel is narrow: counters squeeze side by side down to a
    // shirt's width apart before they wrap, so a shirt never sits on the disc
    // (and its ticket number) of the counter beside it.
    const span = P ? CH - 8 : zoneW,
      minStep = P ? (withAgent ? SH + 6 : 2 * R + 6) : step0;
    const perRow = Math.max(1, Math.floor(span / minStep));
    const rows = Math.ceil(list.length / perRow);
    const step = P ? Math.min(step0, span / Math.min(perRow, list.length)) : step0;
    // Wrapped rows on a phone stagger across the channel, and sit a full
    // counter apart when the stagger alone cannot clear a shirt.
    const stagger = P && rows > 1 ? (perRow > 1 ? step / 2 : Math.min(SH + 6, span - SH)) : 0;
    const rowStep = P ? (withAgent && stagger < SH ? SH + R : 2.4 * R) : 0;
    list.forEach((t, i) => {
      const row = Math.floor(i / perRow),
        col = i % perRow;
      const inRow = Math.min(perRow, list.length - row * perRow);
      let qx = (z.x0 + z.x1) / 2,
        qy = (c + 0.5) * CH;
      const off = (col - (inRow - 1) / 2) * step + (row % 2 ? 0.5 : -0.5) * stagger;
      const roff = (row - (rows - 1) / 2) * (P ? rowStep : Math.min(CH / rows, 2.4 * R));
      if (P) {
        qy += off;
        qx += roff;
      } else {
        qx += off;
        qy += roff;
      }
      if (claimOf(t) && !P) qy += 14;
      if (claimOf(t) && P) qx -= 30;
      pos.set(t.id, [qx, qy]);
    });
  }
  const zoneCentre = (st, repo) => {
    const z = PITCH_ZONES.find((x) => x.key === st);
    return z ? [(z.x0 + z.x1) / 2, (channels.indexOf(repo) + 0.5) * CH] : null;
  };
  const needs = new Set(f.items.map((i) => i.ticket?.id).filter(Boolean));
  const win = arrowWindow(f);
  // On a phone the shirt sits a touch higher, so its hem clears the ticket number.
  const shirtTop = (y) => y - R - SH * 0.925 + (P ? 3 : 9);
  const geo = new Map();
  for (const t of inPlay) {
    const [x, y] = T(...pos.get(t.id));
    const g = { x, y, circles: [{ x, y, r: R + 6 }] };
    box(x - R, y - R, x + R, y + R + 3, "disc");
    if (claimOf(t)) {
      const top = shirtTop(y);
      g.shirt = { top };
      g.circles.push({ x, y: top + SH * 0.52, r: SH * 0.5 + 8 });
      box(x - SH / 2, top + SH * 0.08, x + SH / 2, y, "shirt");
    }
    geo.set(t.id, g);
  }

  const net = svgS("g", { class: "net-tally" });
  const ballAt = new Map();
  channels.forEach((r, c) => {
    const done = f.tickets
      .filter((t) => t.status === "done" && chanOf(t) === r)
      .map((t) => t.number)
      .sort((a, b) => a - b);
    const [x, y] = T(L, (c + 0.5) * CH);
    const gx = P ? x : x + 52,
      gy = P ? M.t - 64 : y - 10,
      br = P ? 15 : 12;
    const g = svgS(
      "g",
      { transform: `translate(${gx} ${gy})`, class: "tally" },
      svgS(
        "title",
        {},
        `${r}: ${done.length} done${done.length ? ` (${done.map((n) => "#" + n).join(", ")})` : ""}`,
      ),
    );
    g.append(pitchBall(br));
    const nw = textWidth(String(done.length), FS.tally);
    if (P)
      g.append(
        svgS(
          "text",
          { x: br + 6, y: FS.tally * 0.36, class: "tally-n", style: pxs(FS.tally) },
          String(done.length),
        ),
      );
    else
      g.append(
        svgS(
          "text",
          {
            x: 0,
            y: br + 6 + FS.tally * 0.75,
            "text-anchor": "middle",
            class: "tally-n",
            style: pxs(FS.tally),
          },
          String(done.length),
        ),
      );
    net.append(g);
    ballAt.set(r, {
      x: gx,
      y: gy,
      r: br,
      extra: P ? [{ x: gx + br + 6 + nw / 2, y: gy, r: Math.max(nw, FS.tally) / 2 + 8 }] : [],
    });
    if (P) box(gx - br - 2, gy - br - 2, gx + br + 10 + nw, gy + br + 2, "ball");
    else box(gx - br - 2, gy - br - 2, gx + br + 2, gy + br + 8 + FS.tally * 0.8, "ball");
  });
  svg.append(net);

  const arrows = svgS("g", { class: "arrows" });
  const mid = `ah-${orientation}-${appState.svgUid}`;
  svg.prepend(
    svgS(
      "defs",
      {},
      svgS(
        "marker",
        {
          id: mid,
          viewBox: "0 0 10 10",
          refX: 6,
          refY: 5,
          markerWidth: 4.5,
          markerHeight: 4.5,
          orient: "auto-start-reverse",
        },
        svgS("path", {
          d: "M0 1 L8 5 L0 9",
          fill: "none",
          stroke: "var(--chalk)",
          "stroke-width": 2,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      ),
    ),
  );
  const allCircles = [...geo.values()].flatMap((g) => g.circles);
  const quad = (a, b, c, t) => [
    (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0],
    (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1],
  ];
  const blossom = (a, b, c, u, v) =>
    [0, 1].map((i) => (1 - u) * (1 - v) * a[i] + ((1 - u) * v + u * (1 - v)) * b[i] + u * v * c[i]);
  const inAny = (p, cs) => cs.some((c) => Math.hypot(p[0] - c.x, p[1] - c.y) < c.r);
  const labelBoxes = obs.filter((o) => ["zl", "cl", "kit", "done"].includes(o.why));
  // Where a move started: the cell's centre, or the nearest open turf in that
  // cell when another counter stands there, so the tail never reads as that
  // counter having moved.
  const freeSpot = (st, repo, own) => {
    const [cx, cy] = zoneCentre(st, repo),
      z = PITCH_ZONES.find((x) => x.key === st);
    const taken = allCircles.filter((c) => !own.includes(c)).map((c) => ({ ...c, r: c.r + 4 }));
    const zw = z.x1 - z.x0;
    const cands = [];
    for (const u of [0, 0.3, -0.3, 0.42, -0.42])
      for (const v of [0, 0.32, -0.32]) cands.push([cx + v * zw, cy + u * CH]);
    cands.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
    const onLabel = ([x, y]) =>
      labelBoxes.some((o) => x > o.x0 - 8 && x < o.x1 + 8 && y > o.y0 - 8 && y < o.y1 + 8);
    return cands.find((q) => !inAny(T(...q), taken) && !onLabel(T(...q))) || [cx, cy];
  };
  const plans = [];
  for (const t of f.tickets) {
    const evs = (f.details.get(t.id)?.events || []).filter((e) => {
      if (e.event_type !== "ticket.transitioned") return false;
      const at = Date.parse(e.created_at);
      return at > win.start && at <= win.end;
    });
    if (!evs.length) continue;
    const repo = chanOf(t);
    if (!repo) continue;
    const done = t.status === "done";
    if ((!done && !geo.has(t.id)) || (done && !ballAt.has(repo))) continue;
    const tgt = done ? ballAt.get(repo) : geo.get(t.id);
    const b = [tgt.x, tgt.y];
    // The arrow starts where the ticket first stood on the pitch in the window. A
    // ticket that only came on from off it (blocked, paused, failed, the bench)
    // comes on from the nearer touchline, beside where it stands now.
    const froms = evs.map((e) => {
      try {
        return JSON.parse(e.payload_json || "{}").from;
      } catch {
        return undefined;
      }
    });
    const far = (q) => q && Math.hypot(b[0] - q[0], b[1] - q[1]) >= 30;
    const onAt = froms.find((s) => ON_PITCH.has(s));
    let a = onAt ? T(...freeSpot(onAt, repo, geo.get(t.id)?.circles || [])) : null,
      on = false;
    if (!far(a) && !done && froms.some((s) => s && !ON_PITCH.has(s))) {
      const here = PITCH_ZONES.find((z) => z.key === t.status);
      const c = channels.indexOf(repo);
      if (here && c >= 0) {
        // Come on at a slant when the touchline is close, so the chalk is long
        // enough to read past the counter.
        const ty = (c + 0.5) * CH < W / 2 ? 6 : W - 6,
          [bx, by] = P ? [M.t + L - b[1], b[0] - M.l] : [b[0] - M.l, b[1] - M.t];
        const d = Math.abs(by - ty),
          need = 110;
        const run = d < need ? Math.sqrt(need * need - d * d) : 0;
        // Slant back towards the start of the lifecycle; forward only when the
        // goal line leaves no room.
        let sx = Math.max(6, bx - run);
        if (Math.hypot(bx - sx, d) < 60) sx = Math.min(L - 6, bx + run);
        a = T(sx, ty);
      } else a = null;
      on = true;
    }
    if (!far(a)) continue;
    plans.push({
      t,
      a,
      b,
      on,
      key: done ? "net|" + repo : "t" + t.id,
      endCs: done ? [{ x: tgt.x, y: tgt.y, r: tgt.r + 9 }, ...tgt.extra] : tgt.circles,
    });
  }
  const byKey = new Map();
  for (const p of plans) (byKey.get(p.key) || byKey.set(p.key, []).get(p.key)).push(p);
  const moved = [],
    arrowPts = [],
    routed = [];
  const pitchArea = P
    ? { x0: M.l + 4, y0: 20, x1: M.l + W - 4, y1: M.t + L - 4 }
    : { x0: M.l + 4, y0: M.t + 4, x1: M.l + L - 4, y1: M.t + W - 4 };
  const inBoxes = (q, bs, pad = 0) =>
    bs.some(
      (o) => q[0] > o.x0 - pad && q[0] < o.x1 + pad && q[1] > o.y0 - pad && q[1] < o.y1 + pad,
    );
  const routeArrow = (p, i, tagBoxes) => {
    const { a, b } = p;
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      len = Math.hypot(dx, dy);
    const base = Math.min(70, len * 0.2) + i * 26;
    const startCs = allCircles.filter((cc) => Math.hypot(a[0] - cc.x, a[1] - cc.y) < cc.r + 14);
    const others = allCircles.filter((cc) => !startCs.includes(cc) && !p.endCs.includes(cc));
    const ctrl = (bend) => [
      (a[0] + b[0]) / 2 + (-dy / len) * bend,
      (a[1] + b[1]) / 2 + (dx / len) * bend,
    ];
    const sign = P ? 1 : -1;
    let c = ctrl(base * sign),
      bestX = Infinity;
    for (const m of [1, -1, 1.7, -1.7, 0.4, -0.4, 2.4, -2.4, 3.2, -3.2]) {
      const cc = ctrl(base * sign * m);
      let x = Math.abs(m) * 0.5;
      for (let j = 1; j < 48; j++) {
        const q = quad(a, cc, b, j / 48);
        if (inAny(q, others)) x += 3;
        if (inBoxes(q, tagBoxes, 6)) x += 6;
        if (inBoxes(q, labelBoxes)) x += 1;
        if (
          q[1] < pitchArea.y0 ||
          q[1] > pitchArea.y1 ||
          q[0] < pitchArea.x0 ||
          q[0] > pitchArea.x1 + (P ? 0 : 60)
        )
          x += 8;
      }
      if (x < bestX) {
        bestX = x;
        c = cc;
      }
    }
    let t0 = 0,
      t1 = 1;
    while (
      t0 < 0.6 &&
      (inAny(
        quad(a, c, b, t0),
        startCs.map((cc) => ({ ...cc, r: cc.r - 2 })),
      ) ||
        Math.hypot(...quad(a, c, b, t0).map((v, j) => v - a[j])) < 10)
    )
      t0 += 0.004;
    while (t0 < 0.5 && inBoxes(quad(a, c, b, t0), tagBoxes, 6)) t0 += 0.004;
    while (t1 > t0 + 0.1 && inAny(quad(a, c, b, t1), p.endCs)) t1 -= 0.004;
    const s0 = blossom(a, c, b, t0, t0),
      c1 = blossom(a, c, b, t0, t1),
      e1 = blossom(a, c, b, t1, t1);
    return Math.hypot(e1[0] - s0[0], e1[1] - s0[1]) < 26 ? null : { s0, c1, e1 };
  };
  for (const group of byKey.values()) {
    group.sort(
      (p, q) =>
        Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) - Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]),
    );
    group.forEach((p, i) => {
      const r = routeArrow(p, i, []);
      if (!r) return;
      for (let j = 0; j <= 36; j++) arrowPts.push(quad(r.s0, r.c1, r.e1, j / 36));
      routed.push({ p, i });
      moved.push({ id: p.t.id, fromXY: p.a });
    });
  }
  svg.append(arrows, labels, kits);

  const layer = svgS("g", { class: "counters" });
  const placed = [];
  const zoneOf = (t) => PITCH_ZONES.findIndex((z) => z.key === t.status);
  const chanIdx = (t) => channels.indexOf(chanOf(t));
  const agentMoves = [];
  const pitchBox = P
    ? { x0: M.l + 2, y0: M.t + 2, x1: M.l + W - 2, y1: M.t + L - 2 }
    : { x0: M.l + 2, y0: M.t + 2, x1: M.l + L - 2, y1: M.t + W - 2 };
  const hits = (b) => {
    let n = 0;
    for (const o of obs)
      if (b.x0 < o.x1 + 3 && b.x1 > o.x0 - 3 && b.y0 < o.y1 + 3 && b.y1 > o.y0 - 3) n += 60;
    // Chalk under a plate costs a little, but never enough on its own to send
    // the plate off on a leader line: the arrows are re-routed round the plates.
    let chalk = 0;
    for (const [qx, qy] of arrowPts)
      if (qx > b.x0 - 5 && qx < b.x1 + 5 && qy > b.y0 - 5 && qy < b.y1 + 5) chalk += 4;
    n += Math.min(chalk, 48);
    if (b.x0 < pitchBox.x0 || b.x1 > pitchBox.x1 || b.y0 < pitchBox.y0 || b.y1 > pitchBox.y1)
      n += 400;
    return n;
  };
  for (const t of inPlay) {
    const { x, y, shirt } = geo.get(t.id);
    const claim = claimOf(t);
    const run = f.runByTicket.get(t.number);
    const nm = needs.has(t.id);
    const who = claim ? agentWho(claim.agent_id, claim.agent_display_name) : null;
    const label = `#${t.number} ${statusLabel(t.status, t.landing_state)}${who ? `, ${who.name}${who.no ? ` (No. ${Number(who.no)})` : ""} on it` : ""}${nm ? ", needs you" : ""}: ${t.title}`;
    const a = svgS("a", {
      href: t.status === "in_review" ? `#/review/${t.id}` : `#/ticket/${t.id}`,
      class: `counter${claim ? " has-agent" : ""}${nm ? " needs" : ""}`,
      "aria-label": label,
    });
    a.append(svgS("title", {}, label));
    const disc = [
      svgS("circle", { cx: x, cy: y + 2.5, r: R, class: "disc-shadow" }),
      svgS("circle", { cx: x, cy: y, r: R, class: "disc" }),
      svgS(
        "text",
        { x, y: y + FS.disc * 0.34, "text-anchor": "middle", class: "disc-n", style: pxs(FS.disc) },
        String(t.number),
      ),
    ];
    if (claim) {
      const no = who.no;
      const g = svgS("g", { class: "agent-on", "data-agent": claim.agent_id });
      g.append(...disc, shirtGroup(no, x - SH / 2, shirt.top, SH / 40, FS.shirt));
      a.append(g);
      const mv = moved.find((m) => m.id === t.id);
      if (mv) agentMoves.push({ g, dx: mv.fromXY[0] - x, dy: mv.fromXY[1] - y });
      const lines = run
        ? run.num_turns
          ? [`${run.num_turns} turns`, money(run.cost_usd)]
          : ["just claimed"]
        : null;
      if (lines) {
        const fs = FS.tag,
          padX = fs * 0.45,
          padY = fs * 0.32,
          lh = fs * 1.12;
        const w = Math.max(...lines.map((l) => textWidth(l, fs, 0.02, "text"))) + padX * 2,
          h = lines.length * lh + padY * 2 - fs * 0.12;
        const top = shirt.top + SH * 0.1,
          gap = 6;
        const cands = [
          { x0: x + SH / 2 + gap, y0: y - h / 2 - (P ? 4 : 2) },
          { x0: x + R + gap, y0: y + 4 },
          { x0: x - SH / 2 - gap - w, y0: y - h / 2 },
          { x0: x - w / 2, y0: y + R + gap + 2 },
          { x0: x - R, y0: y + R + gap + 2 },
          { x0: x + R - w, y0: y + R + gap + 2 },
          { x0: x - w / 2, y0: top - gap - h },
          // Over the shirt, flush with either side of it: a phone's pair of
          // counters side by side leaves room above, not beside.
          { x0: x - SH / 2, y0: top - gap - h },
          { x0: x + SH / 2 - w, y0: top - gap - h },
          { x0: x + SH / 2 + gap, y0: top - 4 },
          { x0: x - SH / 2 - gap - w, y0: top - 4 },
        ].map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x0 + w, y1: c.y0 + h }));
        let best = cands[0],
          bestHits = Infinity;
        for (const c of cands) {
          const hN = hits(c);
          if (hN < bestHits) {
            best = c;
            bestHits = hN;
          }
          if (!hN) break;
        }
        let lead = null;
        // A leader line that runs through another counter would tie the plate
        // to the wrong ticket.
        const others = obs.filter(
          (o) =>
            (o.why === "disc" || o.why === "shirt") &&
            !(o.x0 <= x && o.x1 >= x && o.y0 <= y - 1 && o.y1 >= y - 1) &&
            !(o.why === "shirt" && o.x0 === x - SH / 2),
        );
        const leadCrosses = (c) => {
          const above = c.y1 < shirt.top + SH * 0.2;
          const ox = x,
            oy = above ? shirt.top + SH * 0.12 : y;
          const tx = Math.min(Math.max(ox, c.x0), c.x1),
            ty = Math.min(Math.max(oy, c.y0), c.y1);
          let n = 0;
          for (let j = 1; j < 12; j++) {
            const px = ox + ((tx - ox) * j) / 12,
              py = oy + ((ty - oy) * j) / 12;
            if (others.some((o) => px > o.x0 && px < o.x1 && py > o.y0 && py < o.y1)) n += 60;
          }
          return n;
        };
        if (bestHits >= 60) {
          let bestScore = bestHits * 1000;
          for (let gy = -5; gy <= 5; gy++)
            for (let gx = -4; gx <= 4; gx++) {
              const c = { x0: x - w / 2 + gx * (w * 0.55), y0: y - h / 2 + gy * (h * 0.7) };
              c.x1 = c.x0 + w;
              c.y1 = c.y0 + h;
              const d = Math.hypot((c.x0 + c.x1) / 2 - x, (c.y0 + c.y1) / 2 - y);
              const sc = (hits(c) + leadCrosses(c)) * 1000 + d;
              if (sc < bestScore) {
                bestScore = sc;
                best = c;
                lead = true;
              }
            }
        }
        box(best.x0, best.y0, best.x1, best.y1, "tag");
        const tg = svgS("g", { class: "agent-tag" });
        if (lead) {
          const above = best.y1 < shirt.top + SH * 0.2;
          const ox = x,
            oy = above ? shirt.top + SH * 0.12 : y;
          const tx = Math.min(Math.max(ox, best.x0), best.x1),
            ty = Math.min(Math.max(oy, best.y0), best.y1);
          const dd = Math.hypot(tx - ox, ty - oy) || 1,
            r0 = above ? 2 : R + 3;
          tg.append(
            svgS("circle", {
              cx: ox + ((tx - ox) / dd) * r0,
              cy: oy + ((ty - oy) / dd) * r0,
              r: 2.5,
              class: "tag-dot",
            }),
            svgS("line", {
              x1: ox + ((tx - ox) / dd) * r0,
              y1: oy + ((ty - oy) / dd) * r0,
              x2: tx,
              y2: ty,
              class: "tag-lead",
            }),
          );
        }
        tg.append(
          svgS("rect", { x: best.x0, y: best.y0, width: w, height: h, rx: 3, class: "tag-plate" }),
        );
        lines.forEach((l, i) =>
          tg.append(
            svgS(
              "text",
              {
                x: best.x0 + padX,
                y: best.y0 + padY + fs * 0.8 + i * lh,
                class: `tag-t${i ? " tag-t2" : ""}`,
                style: pxs(fs),
              },
              l,
            ),
          ),
        );
        a.append(tg);
      }
    } else a.append(...disc);
    if (nm) {
      const cx = claim ? x + SH * 0.42 : x + R * 0.8,
        cy = claim ? shirt.top + SH * 0.18 : y - R;
      a.append(
        svgS("rect", {
          x: cx - R * 0.35,
          y: cy - R * 0.45,
          width: R * 0.72,
          height: R * 0.98,
          rx: 2,
          class: "ycard-on",
          transform: `rotate(10 ${cx} ${cy})`,
        }),
      );
      box(cx - R * 0.4, cy - R * 0.5, cx + R * 0.4, cy + R * 0.55, "ycard");
    }
    placed.push({ a, key: P ? [-zoneOf(t), Math.round(y), x] : [chanIdx(t), x, y] });
  }
  // Tab through the counters in the order they sit on the pitch: channel by
  // channel, left to right (on a phone, stage by stage from the top).
  placed.sort((p, q) => p.key[0] - q.key[0] || p.key[1] - q.key[1] || p.key[2] - q.key[2]);
  layer.append(...placed.map((p) => p.a));
  const tagBoxes = obs.filter((o) => o.why === "tag");
  let cameOn = 0;
  for (const { p, i } of routed) {
    const r = routeArrow(p, i, tagBoxes);
    if (!r) continue;
    if (p.on) cameOn++;
    const f1 = (v) => v.toFixed(1);
    arrows.append(
      svgS("path", {
        d: `M${f1(r.s0[0])} ${f1(r.s0[1])} Q${f1(r.c1[0])} ${f1(r.c1[1])} ${f1(r.e1[0])} ${f1(r.e1[1])}`,
        class: p.on ? "arrow arrow-on" : "arrow",
        "marker-end": `url(#${mid})`,
      }),
    );
  }
  svg.append(layer);
  return {
    svg,
    agentMoves,
    arrows,
    cameOn,
    count: inPlay.length,
    arrowsDrawn: arrows.childElementCount,
  };
}

/** Chalk in once, shirts slide from where they were, tags rise: once, never under reduced motion. */
function animatePitch(board) {
  if (prefersReducedMotion() || !board || typeof board.svg.animate !== "function") return;
  board.arrows.querySelectorAll("path").forEach((p, i) => {
    if (typeof p.getTotalLength !== "function") return;
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`;
    p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
      duration: 520,
      delay: 80 + i * 60,
      easing: "cubic-bezier(.16,1,.3,1)",
      fill: "backwards",
    }).finished.then(
      () => (p.style.strokeDasharray = ""),
      () => {},
    );
  });
  board.agentMoves.forEach(({ g, dx, dy }, i) =>
    g.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }], {
      duration: 640,
      delay: 520 + i * 60,
      easing: "cubic-bezier(.16,1,.3,1)",
      fill: "backwards",
    }),
  );
  board.svg.querySelectorAll(".agent-tag").forEach((c, i) =>
    c.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 240,
      delay: 1100 + i * 70,
      fill: "backwards",
    }),
  );
}

function tacticsBoard(f) {
  const boards = {};
  const observers = [];
  const host = (o) => {
    const h = el("div", { class: o === "portrait" ? "pw-port" : "pw-land" });
    let lastK = 0;
    h.fit = () => {
      const w = h.clientWidth;
      if (!w) return false;
      const k = PITCH_VW[o] / w;
      if (Math.abs(k - lastK) / k < 0.02) return false;
      lastK = k;
      boards[o] = pitchBoard(f, o, k);
      h.replaceChildren(boards[o].svg);
      return true;
    };
    boards[o] = pitchBoard(f, o);
    h.append(boards[o].svg);
    if (typeof window.ResizeObserver === "function") {
      const ro = new window.ResizeObserver(() => h.fit());
      ro.observe(h);
      observers.push(ro);
    }
    return h;
  };
  const hl = host("landscape"),
    hp = host("portrait");
  const inPlay = f.tickets.filter((t) => ON_PITCH.has(t.status)).length;
  const off = f.tickets.filter((t) => OFF_PITCH.has(t.status)).sort((a, b) => a.number - b.number);
  const bench = f.tickets.filter((t) => ON_BENCH.has(t.status)).sort((a, b) => a.number - b.number);
  const win = arrowWindow(f);
  const when = win.recent
    ? "in the last 3 hours"
    : `in the 3 hours to the last move (${fmtTime(new Date(win.end).toISOString())})`;
  const { channels } = pitchChannels(f);
  const sec = el("section", { class: "tactics", id: "tactics", "aria-labelledby": "tb-h" }, [
    el("div", { class: "tactics-head" }, [
      el("h2", { id: "tb-h", class: "tb-title" }, [
        "Tactics board",
        // The Work badge counts both, so the two numbers add up in plain sight.
        el(
          "span",
          { class: "panel-aux" },
          off.length ? `${inPlay} in play · ${off.length} off` : `${inPlay} in play`,
        ),
      ]),
      el("p", { class: "tb-note" }, [
        el("span", { class: "tb-land" }, "Left to right"),
        el("span", { class: "tb-port" }, "Bottom to top"),
        ` is the lifecycle; each channel is a repo. Chalk arrows are the moves ${when}.`,
      ]),
    ]),
    channels.length
      ? el("div", { class: "pitch-wrap" }, [hl, hp])
      : el("div", { class: "pitch-wrap is-empty" }, [
          el("p", { class: "pitch-empty" }, "Nobody on the pitch: no ticket is in play yet."),
        ]),
    el("div", { class: "touchline" }, [
      el("div", { class: "dugout" }, [
        el("h3", {}, "Off the pitch"),
        off.length
          ? el(
              "ul",
              {},
              off.map((t) =>
                el("li", {}, [
                  el("a", { href: `#/ticket/${t.id}`, class: `off-${t.status}` }, [
                    statusBadge(t.status, t.landing_state),
                    el("b", {}, `#${t.number}`),
                    el("span", { class: "off-t" }, t.title),
                  ]),
                ]),
              ),
            )
          : el("p", {}, "Nobody: nothing is blocked, paused or failed."),
      ]),
      el("div", { class: "bench" }, [
        el("h3", {}, "Bench"),
        el("p", {}, [
          bench.length
            ? `${bench.filter((t) => t.status === "draft").length} draft, ${bench.filter((t) => t.status === "refining").length} refining: `
            : "Empty.",
          ...bench.flatMap((t, i) => [
            i ? " " : "",
            el("a", { href: `#/ticket/${t.id}`, title: t.title }, `#${t.number}`),
          ]),
        ]),
      ]),
    ]),
    el("ul", { class: "pitch-key", "aria-label": "Key" }, [
      el("li", {}, [agentShirt("01", 26), "Agent (shirt number) on a ticket"]),
      el("li", {}, [
        svgS(
          "svg",
          { viewBox: "0 0 20 20", width: 20, height: 20, "aria-hidden": "true" },
          svgS("circle", { cx: 10, cy: 10, r: 8, class: "key-disc" }),
        ),
        "Ticket",
      ]),
      el("li", {}, [
        el("span", { class: "key-tag", "aria-hidden": "true" }, [
          "31 turns ",
          el("b", {}, "$1.02"),
        ]),
        "Agent's run so far",
      ]),
      el("li", {}, [ycard(18), "Needs you"]),
      el("li", {}, [
        svgS(
          "svg",
          { viewBox: "0 0 40 12", width: 40, height: 12, "aria-hidden": "true" },
          svgS("path", { d: "M2 9 Q20 0 36 6", class: "key-arrow" }),
        ),
        win.recent ? "Moved in the last 3 h" : "Moved in the 3 h to the last move",
      ]),
      // A ticket back on from off the pitch (unblocked, resumed, off the bench)
      // has no stage to come from: its arrow rises from the touchline.
      boards.landscape.cameOn || boards.portrait.cameOn
        ? el("li", {}, [
            svgS(
              "svg",
              { viewBox: "0 0 40 16", width: 40, height: 16, "aria-hidden": "true" },
              svgS("line", { x1: 2, y1: 14, x2: 38, y2: 14, class: "key-line" }),
              svgS("path", { d: "M12 14 Q16 6 28 3", class: "key-arrow" }),
            ),
            "Back on from off the pitch",
          ])
        : null,
      ...channels
        .filter((r) => r !== "Other repos")
        .map((r) => el("li", { class: "key-kit" }, [kitShirt(r, 20), r])),
    ]),
  ]);
  sec._arrive = () => {
    const o = window.matchMedia?.("(max-width: 760px)").matches ? "portrait" : "landscape";
    (o === "portrait" ? hp : hl).fit();
    animatePitch(boards[o]);
  };
  sec._dispose = () => observers.forEach((ro) => ro.disconnect());
  return sec;
}

export { pitchBoard, tacticsBoard };
