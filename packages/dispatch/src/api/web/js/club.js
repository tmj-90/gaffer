// The club and its squad (GET /api/club, GET /api/squad): agent names, display names, capability.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { learnWhoami, paintReadOnly, scoped } from "./access.js";
import { api } from "./api.js";
import { app } from "./dom.js";
import { applyClub } from "./kit.js";
import { refreshCurrentView } from "./live.js";
import { router } from "./router.js";

// Agents are people on the team sheet: a raw agent UUID is never printed. Every
// read of /agents or /claims feeds this map; actorName() falls back to a short id.
const agentNames = new Map();
function learnAgents(list) {
  for (const a of list || []) {
    if (a && a.id && a.display_name) agentNames.set(a.id, a.display_name);
    if (a && a.agent_id && a.agent_display_name) agentNames.set(a.agent_id, a.agent_display_name);
  }
}
let agentsLoaded = null;
/** Load the squad list once per page (best-effort), so feeds can name agents. */
function ensureAgents() {
  if (!agentsLoaded) {
    agentsLoaded = api("GET", "/agents")
      .then((r) => learnAgents(r.agents))
      .catch(() => {
        agentsLoaded = null;
      });
  }
  return Promise.all([agentsLoaded, ensureSquad()]);
}
/** Who did it, in words: "crew-delivery-02", "priya.raman", "the runner". */
function actorName(type, id) {
  const d = id ? squad.byId.get(id) : null;
  if (d && d.display_name_effective) return d.display_name_effective;
  if (id && agentNames.has(id)) return agentNames.get(id);
  if (type === "system" || (!id && type !== "human")) return "the runner";
  if (type === "agent") return id ? `an agent (${String(id).slice(0, 8)})` : "an agent";
  return id || type || "—";
}

// --- The club and its squad (GET /api/club, GET /api/squad) -----------------
//
// The club's identity (its name, the crest's letters, the kit colours) and how
// each agent appears: the operator's name for it, its shirt number and role. The
// agent id stays the identity everywhere (links, keys, joins); a name is only a
// label. The squad is read once per page load, refreshed when the live stream
// says it changed (club.updated, agent.display_updated, agent.registered), and
// any payload that carries the server's `agent_display` refreshes its entry.
const squad = {
  club: null, // ClubView
  agents: [], // SquadAgentView[], in registration order
  byId: new Map(), // agent_id → AgentDisplay (+ registration facts once the squad loads)
  capability: null, // "full" | "read" from /api/whoami; null until known
  scope: null, // { repos, tickets } from /api/whoami for a scoped principal; null: unscoped
  admin: false, // the whoami actor is an admin (repo-level writes inside its scope)
  principal: false, // the token is a named principal (not the shared operator token)
  loaded: null, // the in-flight or settled first read
  whoamiFailed: false, // the gate's whoami failed (not 401): the first squad read skips it
};
const ROLE_LABELS = {
  delivery: "Delivery",
  reviewer: "Reviewer",
  security_reviewer: "Security reviewer",
  tester: "Tester",
};
function learnDisplay(d) {
  if (!d || typeof d !== "object" || !d.agent_id || !d.display_name_effective) return;
  squad.byId.set(d.agent_id, { ...(squad.byId.get(d.agent_id) || {}), ...d });
}
/** The server attaches agent_display to claims, board cards, activity, /agents and a ticket. */
function learnDisplaysFrom(data) {
  const ad = data.agent_display;
  if (ad && typeof ad === "object") {
    if (ad.agent_id) learnDisplay(ad);
    else for (const v of Object.values(ad)) learnDisplay(v);
  }
  for (const k of ["claims", "events", "agents"])
    if (Array.isArray(data[k])) for (const x of data[k]) if (x) learnDisplay(x.agent_display);
  const cards = [];
  for (const c of Array.isArray(data.columns) ? data.columns : []) cards.push(...(c.cards || []));
  for (const k of ["closed", "wontDo"]) if (Array.isArray(data[k])) cards.push(...data[k]);
  for (const card of cards) if (card && card.claim) learnDisplay(card.claim.agent_display);
}
/** Take a GET /api/squad answer: the club (and its kit) and every agent's display. */
function applySquad(res) {
  if (!res || typeof res !== "object") return;
  if (res.club) applyClub(res.club);
  if (Array.isArray(res.agents)) {
    squad.agents = res.agents;
    for (const a of res.agents) learnDisplay(a);
  }
}
/** Read the squad and the token's capability, once per page load (best-effort). */
function ensureSquad() {
  if (!squad.loaded) {
    // The gate already waited once for a whoami that failed or timed out: the views do
    // not wait (up to 15 s more) for a second one. It is asked in the background
    // instead, and a read token's controls switch off when it answers.
    const askLater = !squad.capability && squad.whoamiFailed;
    squad.whoamiFailed = false;
    if (askLater) api("GET", "/api/whoami").then(learnCapability, () => null);
    squad.loaded = Promise.all([
      api("GET", "/api/squad").catch(() => null),
      squad.capability || askLater ? null : api("GET", "/api/whoami").catch(() => null),
    ]).then(([sq, who]) => {
      if (sq) applySquad(sq);
      else squad.loaded = null; // try again on the next view
      learnCapability(who);
    });
  }
  return squad.loaded;
}
/** Take a whoami answer (null: still unknown) and paint what it means. */
function learnCapability(who) {
  const was = squad.capability;
  const wasScoped = scoped();
  if (who && typeof who === "object") learnWhoami(who);
  paintReadOnly();
  // Learned only now that this token is read-only (or scoped): redraw the view, so it
  // shows its switched-off controls rather than the editors it painted first.
  if (
    ((was !== "read" && squad.capability === "read") || (!wasScoped && scoped())) &&
    app.firstElementChild
  )
    router();
}
/**
 * The live stream said the club or a name changed: read the squad again, repaint
 * the crest, and redraw the view even when its own data signature is unchanged.
 */
let squadRefreshBusy = false;
function refreshSquad() {
  if (squadRefreshBusy) return;
  squadRefreshBusy = true;
  squad.loaded = null;
  ensureSquad()
    .then(() => {
      const cur = app.firstElementChild;
      if (cur && cur.dataset) delete cur.dataset.sig;
      refreshCurrentView();
    })
    .finally(() => {
      squadRefreshBusy = false;
    });
}
/** May this operator change names (a full token)? Unknown counts as no: no 403 surprises. */
function canEditSquad() {
  return squad.capability === "full" && !scoped();
}

export {
  agentNames,
  learnAgents,
  ensureAgents,
  actorName,
  squad,
  ROLE_LABELS,
  learnDisplay,
  learnDisplaysFrom,
  applySquad,
  ensureSquad,
  refreshSquad,
  canEditSquad,
};
