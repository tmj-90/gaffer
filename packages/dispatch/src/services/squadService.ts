import { inTransaction, type Db } from "../db/connection.js";
import type { Actor, Agent } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import type { AgentRepository } from "../repositories/agentRepository.js";
import type { ClubRepository } from "../repositories/clubRepository.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";

/**
 * SQUAD — the operator's team identity for the dashboard's Match Day view: the
 * club (name, crest short name, kit colours) and each agent's display name and
 * shirt number.
 *
 * PRESENTATION ONLY. Nothing here touches an agent's `id`: claims, events, the
 * audit log and every gate keep recording the id. A name is a label the
 * dashboard renders, nothing more — and it is set by the OPERATOR (REST full
 * capability / CLI), never by an agent (no MCP tool writes it).
 *
 * Every write is recorded in the tamper-evident event log (`club.updated`,
 * `agent.display_updated`) with a before/after diff of the changed fields.
 */

/** Shown when the operator has not named the club. */
export const DEFAULT_CLUB_NAME = "Gaffer";
export const CLUB_NAME_MAX = 60;
export const CLUB_SHORT_NAME_MAX = 4;
export const AGENT_DISPLAY_NAME_MAX = 40;
export const SHIRT_NUMBER_MIN = 1;
export const SHIRT_NUMBER_MAX = 99;

/** Accepted kit colour forms (`#rgb` / `#rrggbb`); stored as lowercase `#rrggbb`. */
export const KIT_COLOUR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Crest short name: 1–4 letters/digits (any script), `&` or `.`. */
const SHORT_NAME_RE = /^[\p{L}\p{N}&.]{1,4}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** The role a registered agent plays in the factory, derived from its registration. */
export type SquadRole = "delivery" | "reviewer" | "security_reviewer" | "tester";

const ROLE_LABEL: Record<SquadRole, string> = {
  delivery: "Delivery",
  reviewer: "Reviewer",
  security_reviewer: "Security reviewer",
  tester: "Tester",
};

/** How an agent is presented wherever the API returns its identity (`agent_display`). */
export interface AgentDisplay {
  /** The agent id — unchanged by any rename; what claims/events record. */
  agent_id: string;
  /** The operator-chosen name, or null when unset. */
  display_name: string | null;
  /** What to render: `display_name` when set, else {@link default_display_name}. */
  display_name_effective: string;
  /** The deterministic derived name: role + index ("Delivery 1", "Reviewer", …). */
  default_display_name: string;
  /** The 1–99 squad number, or null when unset. */
  shirt_number: number | null;
  role: SquadRole;
}

/** One squad member for GET /api/squad: the display plus the registration facts. */
export interface SquadAgentView extends AgentDisplay {
  /** The label the agent registered with (`agents.display_name`, e.g. gaffer-factory). */
  registered_name: string | null;
  agent_type: string;
  status: Agent["status"];
  max_risk: Agent["max_risk"];
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The club identity as the API returns it. */
export interface ClubView {
  name: string | null;
  short_name: string | null;
  kit_primary: string | null;
  kit_secondary: string | null;
  /** `name`, or "Gaffer" when unset. */
  name_effective: string;
  /** `short_name`, or one derived from `name_effective` (initials / first 3 letters). */
  short_name_effective: string;
  /** Who last changed it and when (null until the first write). */
  updated_by: string | null;
  updated_at: string | null;
}

/**
 * A club update. Per field: omitted/undefined ⇒ unchanged; null or "" ⇒ cleared
 * back to the default; a value ⇒ validated and set.
 */
export interface ClubUpdate {
  name?: string | null | undefined;
  short_name?: string | null | undefined;
  kit_primary?: string | null | undefined;
  kit_secondary?: string | null | undefined;
}

/** An agent display update, with the same omitted / null-clears semantics. */
export interface AgentDisplayUpdate {
  display_name?: string | null | undefined;
  shirt_number?: number | null | undefined;
}

type Change = { from: unknown; to: unknown };

/**
 * Derive an agent's role from what it registered as. The runner registers the
 * delivery agent under the factory's agent name (e.g. `gaffer-factory`) and the
 * reviewer principal as `<that name>-reviewer`; a security reviewer / tester is
 * recognised the same way. Everything else is a delivery agent.
 */
export function deriveSquadRole(agent: Pick<Agent, "display_name" | "agent_type">): SquadRole {
  const label = `${agent.agent_type ?? ""} ${agent.display_name ?? ""}`.toLowerCase();
  if (label.includes("security")) return "security_reviewer";
  if (label.includes("tester")) return "tester";
  if (label.includes("reviewer")) return "reviewer";
  return "delivery";
}

/**
 * The derived default names for every agent, keyed by id. `agents` must be in
 * registration order. Delivery agents are always numbered ("Delivery 1", …); the
 * single-seat roles read bare for the first holder and numbered from the second
 * ("Reviewer", "Reviewer 2"), so registering a new agent never renames an
 * existing one.
 */
export function deriveDefaultNames(agents: readonly Agent[]): Map<string, string> {
  const seen: Record<SquadRole, number> = {
    delivery: 0,
    reviewer: 0,
    security_reviewer: 0,
    tester: 0,
  };
  const out = new Map<string, string>();
  for (const a of agents) {
    const role = deriveSquadRole(a);
    const n = ++seen[role];
    const label = ROLE_LABEL[role];
    out.set(a.id, role === "delivery" || n > 1 ? `${label} ${n}` : label);
  }
  return out;
}

/** Initials of up to four words, else the first three characters, upper-cased. */
export function deriveShortName(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return "GAF";
  if (words.length === 1) return [...(words[0] as string)].slice(0, 3).join("").toUpperCase();
  return words
    .slice(0, CLUB_SHORT_NAME_MAX)
    .map((w) => [...w][0] as string)
    .join("")
    .toUpperCase();
}

/** Trim; "" ⇒ null (clear). Undefined passes through (unchanged). */
function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  const t = v.trim();
  return t === "" ? null : t;
}

function validationError(message: string, details: Record<string, unknown>): DispatchError {
  return new DispatchError("VALIDATION_ERROR", message, details);
}

export function validateClubName(raw: string | null | undefined): string | null | undefined {
  const v = blankToNull(raw);
  if (v == null) return v;
  if ([...v].length > CLUB_NAME_MAX || CONTROL_RE.test(v)) {
    throw validationError(
      `Club name must be at most ${CLUB_NAME_MAX} characters with no control characters.`,
      { field: "name" },
    );
  }
  return v;
}

export function validateShortName(raw: string | null | undefined): string | null | undefined {
  const v = blankToNull(raw);
  if (v == null) return v;
  if (!SHORT_NAME_RE.test(v)) {
    throw validationError(
      `Club short name must be 1–${CLUB_SHORT_NAME_MAX} letters or digits ('&' and '.' allowed).`,
      { field: "short_name", value: v },
    );
  }
  return v;
}

/** Validate a kit colour; returns the canonical lowercase `#rrggbb`. */
export function validateKitColour(
  raw: string | null | undefined,
  field: string,
): string | null | undefined {
  const v = blankToNull(raw);
  if (v == null) return v;
  if (!KIT_COLOUR_RE.test(v)) {
    throw validationError(`${field} must be a hex colour like #1d4ed8 (or #fff).`, {
      field,
      value: v,
    });
  }
  const hex = v.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

export function validateAgentDisplayName(
  raw: string | null | undefined,
): string | null | undefined {
  const v = blankToNull(raw);
  if (v == null) return v;
  if ([...v].length > AGENT_DISPLAY_NAME_MAX || CONTROL_RE.test(v)) {
    throw validationError(
      `Display name must be at most ${AGENT_DISPLAY_NAME_MAX} characters with no control characters.`,
      { field: "display_name" },
    );
  }
  return v;
}

export function validateShirtNumber(raw: number | null | undefined): number | null | undefined {
  if (raw == null) return raw;
  if (!Number.isInteger(raw) || raw < SHIRT_NUMBER_MIN || raw > SHIRT_NUMBER_MAX) {
    throw validationError(
      `Shirt number must be a whole number from ${SHIRT_NUMBER_MIN} to ${SHIRT_NUMBER_MAX}.`,
      { field: "shirt_number", value: raw },
    );
  }
  return raw;
}

export interface SquadServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly agents: AgentRepository;
  readonly club: ClubRepository;
}

export class SquadService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly agents: AgentRepository;
  private readonly club: ClubRepository;

  constructor(deps: SquadServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.agents = deps.agents;
    this.club = deps.club;
  }

  // --- Club --------------------------------------------------------------------

  getClub(): ClubView {
    const row = this.club.get();
    const name = row?.name ?? null;
    const shortName = row?.short_name ?? null;
    const effective = name ?? DEFAULT_CLUB_NAME;
    return {
      name,
      short_name: shortName,
      kit_primary: row?.kit_primary ?? null,
      kit_secondary: row?.kit_secondary ?? null,
      name_effective: effective,
      short_name_effective: shortName ?? deriveShortName(effective),
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at ?? null,
    };
  }

  /** Apply a validated club update; records `club.updated` when anything changed. */
  updateClub(input: ClubUpdate, actor: Actor): { club: ClubView; changed: string[] } {
    const next = {
      name: validateClubName(input.name),
      short_name: validateShortName(input.short_name),
      kit_primary: validateKitColour(input.kit_primary, "kit_primary"),
      kit_secondary: validateKitColour(input.kit_secondary, "kit_secondary"),
    };
    return inTransaction(this.db, () => {
      const current = this.getClub();
      const changes: Record<string, Change> = {};
      const merged = {
        name: current.name,
        short_name: current.short_name,
        kit_primary: current.kit_primary,
        kit_secondary: current.kit_secondary,
      };
      for (const key of Object.keys(next) as Array<keyof typeof next>) {
        const v = next[key];
        if (v === undefined || v === merged[key]) continue;
        changes[key] = { from: merged[key], to: v };
        merged[key] = v;
      }
      const changed = Object.keys(changes);
      if (changed.length === 0) return { club: current, changed };
      this.club.upsert({
        ...merged,
        updated_by: actor.id ?? actor.type,
        updated_at: this.clock.now(),
      });
      writeEvent(this.db, {
        entity_type: "club",
        entity_id: "club",
        actor,
        event_type: "club.updated",
        payload: { changes },
      });
      return { club: this.getClub(), changed };
    });
  }

  // --- Agents ------------------------------------------------------------------

  /** Every agent's presentation, keyed by agent id (one query, derived defaults). */
  displayMap(): Map<string, AgentDisplay> {
    const agents = this.agents.listInRegistrationOrder();
    const defaults = deriveDefaultNames(agents);
    const out = new Map<string, AgentDisplay>();
    for (const a of agents) out.set(a.id, toDisplay(a, defaults.get(a.id) as string));
    return out;
  }

  /** The squad in registration order (the stable order the defaults are numbered in). */
  listSquad(): SquadAgentView[] {
    const agents = this.agents.listInRegistrationOrder();
    const defaults = deriveDefaultNames(agents);
    return agents.map((a) => toSquadView(a, defaults.get(a.id) as string));
  }

  /**
   * Resolve an agent by id, else by its unique registered name. Never by display
   * name: that is presentation, and two agents may share one.
   */
  resolveAgent(ref: string): Agent {
    const byId = this.agents.findById(ref);
    if (byId) return byId;
    const byName = this.agents.findByRegisteredName(ref);
    if (byName.length === 1) return byName[0] as Agent;
    if (byName.length > 1) {
      throw validationError(`More than one agent registered as '${ref}' — use the agent id.`, {
        ref,
        ids: byName.map((a) => a.id),
      });
    }
    throw notFound("agent", ref);
  }

  /**
   * Set an agent's display name and/or shirt number. The shirt number must not be
   * worn by another agent (DUPLICATE). Records `agent.display_updated` when
   * anything changed. The agent id is never touched.
   */
  updateAgentDisplay(
    ref: string,
    input: AgentDisplayUpdate,
    actor: Actor,
  ): { agent: SquadAgentView; changed: string[] } {
    const nextName = validateAgentDisplayName(input.display_name);
    const nextNumber = validateShirtNumber(input.shirt_number);
    return inTransaction(this.db, () => {
      const agent = this.resolveAgent(ref);
      const changes: Record<string, Change> = {};
      let squadName = agent.squad_name;
      let shirtNumber = agent.shirt_number;
      if (nextName !== undefined && nextName !== squadName) {
        changes.display_name = { from: squadName, to: nextName };
        squadName = nextName;
      }
      if (nextNumber !== undefined && nextNumber !== shirtNumber) {
        if (nextNumber !== null) {
          const holder = this.agents.findByShirtNumber(nextNumber);
          if (holder && holder.id !== agent.id) {
            const who = this.displayMap().get(holder.id)?.display_name_effective ?? holder.id;
            throw new DispatchError(
              "DUPLICATE",
              `Shirt number ${nextNumber} is already worn by ${who}.`,
              { shirt_number: nextNumber, agent_id: holder.id },
            );
          }
        }
        changes.shirt_number = { from: shirtNumber, to: nextNumber };
        shirtNumber = nextNumber;
      }
      const changed = Object.keys(changes);
      if (changed.length > 0) {
        this.agents.setSquadProfile(
          agent.id,
          { squad_name: squadName, shirt_number: shirtNumber },
          this.clock.now(),
        );
        writeEvent(this.db, {
          entity_type: "agent",
          entity_id: agent.id,
          actor,
          event_type: "agent.display_updated",
          payload: { changes },
        });
      }
      const view = this.listSquad().find((a) => a.agent_id === agent.id);
      if (!view) throw notFound("agent", ref);
      return { agent: view, changed };
    });
  }
}

function toDisplay(a: Agent, defaultName: string): AgentDisplay {
  return {
    agent_id: a.id,
    display_name: a.squad_name ?? null,
    display_name_effective: a.squad_name ?? defaultName,
    default_display_name: defaultName,
    shirt_number: a.shirt_number ?? null,
    role: deriveSquadRole(a),
  };
}

function toSquadView(a: Agent, defaultName: string): SquadAgentView {
  return {
    ...toDisplay(a, defaultName),
    registered_name: a.display_name,
    agent_type: a.agent_type,
    status: a.status,
    max_risk: a.max_risk,
    last_seen_at: a.last_seen_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}
