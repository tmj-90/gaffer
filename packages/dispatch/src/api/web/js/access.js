// Read-only and scoped access: what this token may do, and the locks the views draw for it.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentNames, squad } from "./club.js";
import { appbar, clear, el } from "./dom.js";
import { agentNo, icon } from "./icons.js";

// --- Read-only access ---------------------------------------------------------
// A read token (GET /api/whoami capability "read") may look at everything and
// change nothing: the server refuses every write. So the dashboard does not offer
// one: every control that would change something is switched off with a title that
// says why, and one strip under the header says so once. Unknown counts as full
// here (the server still refuses), so a slow whoami never greys out a full token.
const READ_ONLY_TITLE = "Read-only access: this token can look, not change anything.";
function readOnly() {
  return squad.capability === "read";
}
/** Take a whoami answer: the capability, and a scoped principal's scope. */
function learnWhoami(who) {
  if (who.capability) squad.capability = who.capability;
  else if (!squad.capability) squad.capability = "full";
  squad.scope = who.scope && (who.scope.repos || who.scope.tickets) ? who.scope : null;
  squad.admin = Boolean(who.actor && who.actor.type === "admin");
  squad.principal = Boolean(who.principal);
}
/** A named principal that is not an admin: repository-level writes are refused. */
function needsAdmin() {
  return squad.principal && !squad.admin;
}
const ADMIN_TITLE =
  "Admin access: repository and settings changes need an admin credential (Settings → Access, Acts as admin).";

// --- Scoped access --------------------------------------------------------------
// A principal minted with a repo or ticket scope sees only its tickets, and the server
// refuses everything factory-wide (403 SCOPE_DENIED). So the dashboard shows the
// board, the tickets and the review of what it holds, switches every factory-wide
// control off with a title naming the scope, and says so in one strip under the
// header. The ticket controls on a ticket it holds stay live: they are in scope.
function scoped() {
  return squad.scope !== null;
}
/** "repos app, svc and tickets #4" — the scope in words. */
function scopeWords() {
  const sc = squad.scope || {};
  const parts = [];
  if (sc.repos && sc.repos.length)
    parts.push(
      `${sc.repos.length === 1 ? "repo" : "repos"} ${sc.repos.map((r) => r.name || r.id).join(", ")}`,
    );
  if (sc.tickets && sc.tickets.length)
    parts.push(
      `${sc.tickets.length === 1 ? "ticket" : "tickets"} ${sc.tickets.map((t) => "#" + (t.number ?? t.id)).join(", ")}`,
    );
  return parts.join(" and ") || "nothing";
}
function scopeTitle() {
  return `Scoped access: this token can change only the tickets in its scope (${scopeWords()}).`;
}
/** Would the server refuse this call for the scoped token? Mirrors api/scopeGate.ts. */
function scopeRefuses(method, path) {
  const seg = String(path).split("?")[0].split("/").filter(Boolean);
  const [head, second, third] = seg;
  if (!scoped()) return needsAdmin() && method !== "GET" && method !== "HEAD" && repoLevel(seg);
  if (needsAdmin() && method !== "GET" && method !== "HEAD" && repoLevel(seg)) return true;
  if (method === "GET" || method === "HEAD") {
    if (head === "tickets" || head === "claims" || head === "decisions") return false;
    if ((head === "repositories" || head === "agents") && seg.length === 1) return false;
    // Every repo's grounds in one read: the server filters it to the repos in scope.
    if (head === "scope" && second === "repos" && seg.length === 2 && /[?&]all=1(&|$)/.test(path))
      return false;
    if (
      head === "api" &&
      seg.length === 2 &&
      ["whoami", "squad", "club", "openapi.json", "board", "human-queue"].includes(second)
    )
      return false;
    if (head === "api" && second === "events" && third === "stream") return false;
    return true;
  }
  if (head === "tickets") {
    if (["repo-access", "work-repos", "mono-fallback"].includes(third)) return !squad.admin;
    // Epic and map membership is the operator's (it rewires the epic's other tickets).
    if (third === "scopes" || third === "primary-scope") return true;
    return false;
  }
  if (head === "claims" || head === "decisions") return false;
  if (head === "repos" && second && second !== "onboard" && squad.admin) {
    return !(squad.scope.repos || []).some((r) => r.id === second || r.name === second);
  }
  return true;
}
/** A repository-level write (api/scopeGate.ts `write_repo`): an admin's to make. */
function repoLevel(seg) {
  const [head, second, third] = seg;
  if (head === "repos") return true;
  if (head === "tickets" && ["repo-access", "work-repos", "mono-fallback"].includes(third))
    return true;
  return head === "api" && ["settings", "idle-loops", "autonomy"].includes(second);
}
/** Why a control is switched off for this token (null: it is not). */
function lockReason(kind) {
  if (readOnly()) return READ_ONLY_TITLE;
  if (scoped() && kind !== "ticket") return scopeTitle();
  if (kind === "repo" && needsAdmin()) return ADMIN_TITLE;
  return null;
}
/**
 * Switch one control off (disabled + a title saying why) for a read token, or for a
 * scoped token when the control is factory-wide. `kind` "ticket" marks a control that
 * acts on the one ticket in view: a scoped token only ever sees tickets in its scope,
 * so those stay live for it.
 */
function roLock(node, kind) {
  const why = node ? lockReason(kind) : null;
  if (!why) return node;
  if ("disabled" in node && node.tagName !== "A") node.disabled = true;
  node.setAttribute("aria-disabled", "true");
  node.classList.add(readOnly() ? "is-read-only" : "is-scope-locked");
  node.title = why;
  return node;
}
/** Switch off every form control and button inside `root` (a whole editor). */
function roLockAll(root, kind) {
  if (!root || !lockReason(kind)) return root;
  for (const n of root.querySelectorAll("button, input, select, textarea"))
    if (!n.closest("[data-ro-ok]")) roLock(n, kind);
  return root;
}
/** The one read-only strip under the header. */
function paintReadOnly() {
  let strip = document.getElementById("ro-strip");
  if (!strip && readOnly() && appbar) {
    strip = el("div", { class: "ro-strip", id: "ro-strip", role: "status" }, [
      el("div", {}, [
        icon("lock", "", 16),
        el("span", {}, [
          el("b", {}, "Read-only access. "),
          "This token can look at everything and change nothing, so the buttons that would change something are switched off. Sign in with a full token to act.",
        ]),
      ]),
    ]);
    appbar.after(strip);
  }
  if (strip) strip.hidden = !readOnly();
  document.body.classList.toggle("is-read-only", readOnly());
  let sstrip = document.getElementById("scope-strip");
  if (!sstrip && scoped() && !readOnly() && appbar) {
    sstrip = el("div", { class: "ro-strip", id: "scope-strip", role: "status" }, [
      el("div", {}, [icon("lock", "", 16), el("span", { class: "scope-strip-text" })]),
    ]);
    (document.getElementById("ro-strip") || appbar).after(sstrip);
  }
  if (sstrip) {
    sstrip.hidden = !scoped() || readOnly();
    const text = sstrip.querySelector(".scope-strip-text");
    if (text && scoped()) {
      clear(text);
      text.append(
        el("b", {}, "Scoped access. "),
        `This token sees and changes only ${scopeWords()}. Factory-wide controls (polling, planning, the map, settings) are switched off.`,
      );
    }
  }
  document.body.classList.toggle("is-scoped", scoped());
}
/**
 * An agent as the squad knows it: { id, name, no, reg, role }. `name` is the
 * display name (the server's display_name_effective), else `fallback` (the
 * registered label a payload carried); `no` is its shirt number, else the
 * trailing digits of its registered name (the old index scheme: 01, 02…).
 */
function agentWho(id, fallback) {
  const d = id ? squad.byId.get(id) : null;
  const reg = (d && d.registered_name) || (id && agentNames.get(id)) || fallback || null;
  const name =
    (d && d.display_name_effective) ||
    fallback ||
    reg ||
    (id ? `an agent (${String(id).slice(0, 8)})` : "an agent");
  const no = d && d.shirt_number != null ? String(d.shirt_number) : agentNo(reg || name);
  return { id, name, no, reg, role: (d && d.role) || null };
}
/** "Kev, No. 9 (crew-delivery-02)": the hover text for a shirt. */
function agentTitle(w) {
  const num = w.no ? `, No. ${Number(w.no)}` : "";
  return `${w.name}${num}${w.reg && w.reg !== w.name ? ` (${w.reg})` : ""}`;
}

export {
  READ_ONLY_TITLE,
  readOnly,
  learnWhoami,
  ADMIN_TITLE,
  scoped,
  scopeTitle,
  scopeRefuses,
  lockReason,
  roLock,
  roLockAll,
  paintReadOnly,
  agentWho,
  agentTitle,
};
