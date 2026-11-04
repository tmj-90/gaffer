// Data freshness: the tracker behind the header's Data as of line.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { clear, el } from "./dom.js";
import { glyph } from "./icons.js";

// --- Data freshness ----------------------------------------------------------
//
// The header shows WHEN the data on screen was last confirmed by the server —
// the time of the last API response or live-stream byte — never a lamp that
// stays lit when the factory is unreachable (live-lamp-hardcoded). States:
//   live     the event stream is connected (pushes arrive within a second)
//   polling  the stream is down but API calls succeed (9s refresh fallback)
//   offline  the last call failed to reach the server, or nothing has been
//            confirmed for 2.5 refresh intervals — actions pause, data is stale
//   auth     the server refused our token
const FRESH_STALE_MS = 2.5 * 9000;
const freshness = {
  lastOkAt: 0,
  lastFailAt: 0,
  failKind: null,
  stream: "down",
  listeners: new Set(),
  ok() {
    const was = this.state();
    this.lastOkAt = Date.now();
    this.failKind = null;
    this.emit(was);
  },
  fail(kind) {
    const was = this.state();
    this.lastFailAt = Date.now();
    this.failKind = kind;
    this.emit(was);
  },
  setStream(state) {
    const was = this.state();
    this.stream = state;
    if (state === "up") this.lastOkAt = Date.now();
    this.emit(was);
  },
  state(now = Date.now()) {
    if (this.failKind === "auth") return "auth";
    if (this.failKind === "network" && this.lastFailAt >= this.lastOkAt) return "offline";
    if (!this.lastOkAt) return "connecting";
    if (now - this.lastOkAt > FRESH_STALE_MS && this.stream !== "up") return "offline";
    return this.stream === "up" ? "live" : "polling";
  },
  emit(was) {
    const now = this.state();
    for (const fn of this.listeners) fn(now, was);
  },
};

/** "18:58" in the viewer's clock (the header line is a fact, not a countdown). */
function clockTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Paint the header freshness line from the tracker (also re-run every 15s). */
function paintFreshness() {
  const node = document.getElementById("freshness");
  if (!node) return;
  const st = freshness.state();
  node.dataset.state = st;
  clear(node);
  const at = freshness.lastOkAt;
  if (st === "auth") {
    node.appendChild(el("span", { class: "rail-status-text" }, "Token refused"));
  } else if (st === "offline") {
    node.appendChild(glyph("blocked", 12));
    node.appendChild(
      el("span", {}, [
        "Offline",
        at
          ? el("span", { class: "rail-status-text" }, [
              " · data from ",
              el("time", { datetime: new Date(at).toISOString() }, clockTime(at)),
            ])
          : null,
      ]),
    );
  } else if (at) {
    node.appendChild(
      el("span", { class: "rail-status-text" }, [
        el("span", { class: "rs-prefix" }, st === "live" ? "Live · data as of " : "Data as of "),
        el("time", { datetime: new Date(at).toISOString() }, clockTime(at)),
      ]),
    );
  } else {
    node.appendChild(el("span", { class: "rail-status-text" }, "Connecting…"));
  }
  node.title =
    st === "live"
      ? "Connected to the factory's event stream; updates arrive as they happen."
      : st === "polling"
        ? "The live stream is down; the view refreshes every 9 seconds."
        : st === "offline"
          ? "Can't reach the factory. What you see is from the time shown; actions are paused."
          : st === "auth"
            ? "The factory refused this token."
            : "Waiting for the first answer from the factory.";
  document.body.classList.toggle("is-offline", st === "offline");
  const strip = document.getElementById("offline-strip");
  if (strip) {
    strip.hidden = st !== "offline";
    if (st === "offline") {
      clear(strip);
      strip.appendChild(
        el("div", {}, [
          glyph("blocked", 14),
          at
            ? `Can't reach the factory. You're looking at data from ${clockTime(at)}; actions are paused until it answers.`
            : "Can't reach the factory. Actions are paused until it answers.",
        ]),
      );
    }
  }
}

export { freshness, clockTime, paintFreshness };
