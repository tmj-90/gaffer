import type { Db } from "../db/connection.js";

/** The single `club` row (schema v27). Every field but `updated_at` may be NULL. */
export interface ClubRow {
  name: string | null;
  short_name: string | null;
  kit_primary: string | null;
  kit_secondary: string | null;
  updated_by: string | null;
  updated_at: string;
}

/** Data access for the club identity (one row, id = 1). No business rules here. */
export class ClubRepository {
  constructor(private readonly db: Db) {}

  get(): ClubRow | undefined {
    return this.db
      .prepare(
        `SELECT name, short_name, kit_primary, kit_secondary, updated_by, updated_at
         FROM club WHERE id = 1`,
      )
      .get() as ClubRow | undefined;
  }

  upsert(row: ClubRow): void {
    this.db
      .prepare(
        `INSERT INTO club (id, name, short_name, kit_primary, kit_secondary, updated_by, updated_at)
         VALUES (1, @name, @short_name, @kit_primary, @kit_secondary, @updated_by, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           short_name = excluded.short_name,
           kit_primary = excluded.kit_primary,
           kit_secondary = excluded.kit_secondary,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(row);
  }
}
