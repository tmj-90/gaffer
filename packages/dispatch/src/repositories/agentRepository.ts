import type { Db } from "../db/connection.js";
import type { Agent } from "../domain/types.js";

/** Data access for agents and their capabilities. No business rules here. */
export class AgentRepository {
  constructor(private readonly db: Db) {}

  insert(agent: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents
          (id, display_name, agent_type, model, runtime, host, max_risk, status,
           created_by, last_seen_at, created_at, updated_at)
         VALUES
          (@id, @display_name, @agent_type, @model, @runtime, @host, @max_risk, @status,
           @created_by, @last_seen_at, @created_at, @updated_at)`,
      )
      .run(agent);
  }

  addCapability(agentId: string, capability: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO agent_capabilities (agent_id, capability) VALUES (?, ?)`)
      .run(agentId, capability);
  }

  findById(id: string): Agent | undefined {
    return this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Agent | undefined;
  }

  list(): Agent[] {
    return this.db.prepare(`SELECT * FROM agents ORDER BY created_at DESC`).all() as Agent[];
  }

  capabilities(agentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT capability FROM agent_capabilities WHERE agent_id = ? ORDER BY capability ASC`,
      )
      .all(agentId) as Array<{ capability: string }>;
    return rows.map((r) => r.capability);
  }

  touchLastSeen(id: string, nowIso: string): void {
    this.db
      .prepare(`UPDATE agents SET last_seen_at = @now, updated_at = @now WHERE id = @id`)
      .run({ id, now: nowIso });
  }
}
