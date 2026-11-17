/**
 * SEALED AUTONOMY (S5 part B), the cost: a VERIFIED CHECKPOINT beside the anchor, under the
 * factory key, lets a new process verify only the tail of the event log.
 *
 *  - a fresh process after a checkpoint makes no walk from genesis, and decides correctly;
 *  - a forged checkpoint (its body changed, or one under another key) is refused: a person
 *    decides, it is never skipped;
 *  - a checkpoint the log no longer matches (the database rolled back under it) is refused;
 *  - an OLDER genuine checkpoint put back does not hide a step-down deleted after it;
 *  - a lifecycle event deleted BEFORE the checkpoint (no rechain) is caught in a fresh process;
 *  - the served path: a handle that verified sees another process's commits correctly.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { inTransaction } from "../src/db/connection.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { factoryKeyId, fileGateKeyring } from "../src/events/gateSeal.js";
import { rowSealFullWalks } from "../src/events/rowSeal.js";
import { AUTONOMY_STEPPED_DOWN_EVENT } from "../src/services/autonomyStepDownStore.js";
import { systemClock } from "../src/util/clock.js";
import { repoNamed, ticketOn } from "./helpers/autonomyLadder.js";

const human: Actor = { type: "human", id: "tom" };
const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f];
    delete process.env[f];
  }
});
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

interface World {
  dbPath: string;
  keysDir: string;
  cpPath: string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "s5b-cp-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keysDir = join(root, "keys");
  fileGateKeyring({ dbPath, keysDir }).ensure();
  return {
    dbPath,
    keysDir,
    cpPath: join(keysDir, `${factoryKeyId(dbPath)}.anchor`, "chain-checkpoint.json"),
  };
}

/** A process on the factory (a fresh handle, so a fresh chain memory). */
function proc(w: World): Dispatch {
  return Dispatch.open(w.dbPath, systemClock, undefined, {
    gateKeyring: fileGateKeyring({ dbPath: w.dbPath, keysDir: w.keysDir }),
  });
}

function enable(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  return wg.setAutonomyPolicy(
    { repoId, riskLevel: risk, gate, mode: "auto", confirm: true },
    human,
  );
}

function decide(wg: Dispatch, ticketId: string, gate: "approve" | "merge") {
  return wg.autonomyGateDecision(wg.resolveTicket(ticketId), gate).decision;
}

function pad(wg: Dispatch, ticketId: string, n: number) {
  inTransaction(wg.db, () => {
    for (let i = 0; i < n; i++) {
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: ticketId,
        actor: human,
        event_type: "note.added",
        payload: { i },
      });
    }
  });
}

/** A factory with signed low rows, a low ticket on the repo and a long log. */
function setup(w: World): { api: string; ticket: string } {
  const wg = proc(w);
  try {
    const api = repoNamed(wg, "api");
    enable(wg, api, "low", "approve");
    enable(wg, api, "low", "merge");
    const t = ticketOn(wg, "api", "low");
    pad(wg, t.id, 1200);
    // The first verification walks from genesis and records the checkpoint.
    expect(decide(wg, t.id, "merge")).toBe("allow");
    return { api, ticket: t.id };
  } finally {
    wg.db.close();
  }
}

describe("the verified checkpoint", () => {
  it("a fresh process after a checkpoint walks only the tail, and decides correctly", () => {
    const w = world();
    const { ticket } = setup(w);
    expect(JSON.parse(readFileSync(w.cpPath, "utf8"))).toHaveProperty("mac");
    const before = rowSealFullWalks();
    const wg = proc(w);
    try {
      expect(decide(wg, ticket, "merge")).toBe("allow");
      expect(decide(wg, ticket, "approve")).toBe("allow");
      expect(rowSealFullWalks()).toBe(before);
    } finally {
      wg.db.close();
    }
  });

  it("a forged checkpoint is refused, never skipped: a person decides", () => {
    const w = world();
    const { ticket } = setup(w);
    const file = JSON.parse(readFileSync(w.cpPath, "utf8")) as { body: string; mac: string };
    const body = JSON.parse(file.body) as Record<string, unknown>;
    // Its body changed (say, to cover a row it never verified), the MAC left as it was.
    writeFileSync(w.cpPath, JSON.stringify({ ...file, body: JSON.stringify({ ...body, seq: 3 }) }));
    let wg = proc(w);
    try {
      expect(decide(wg, ticket, "merge")).toBe("deny");
      expect(wg.listAutonomyPolicies()[0]!.seal_problem).toMatch(/checkpoint is refused/);
    } finally {
      wg.db.close();
    }
    // Garbage, and a MAC made with another key: refused too.
    writeFileSync(w.cpPath, "{not json");
    wg = proc(w);
    try {
      expect(decide(wg, ticket, "merge")).toBe("deny");
    } finally {
      wg.db.close();
    }
    writeFileSync(w.cpPath, JSON.stringify({ body: file.body, mac: "ab".repeat(32) }));
    wg = proc(w);
    try {
      expect(decide(wg, ticket, "merge")).toBe("deny");
    } finally {
      wg.db.close();
    }
  });

  it("a checkpoint the log no longer matches (the database and its anchor rolled back under it) is refused", () => {
    const w = world();
    const { ticket } = setup(w);
    const anchorDir = join(w.keysDir, `${factoryKeyId(w.dbPath)}.anchor`);
    const anchorsNow = (): string[] =>
      readdirSync(anchorDir).filter((n) => /^\d{16}\.json$/.test(n));
    const earlierDb = `${w.dbPath}.earlier`;
    copyFileSync(w.dbPath, earlierDb);
    const earlierAnchor = anchorsNow()[0]!;
    const earlierAnchorBody = readFileSync(join(anchorDir, earlierAnchor));
    // The factory moves on: more events, a new checkpoint past the copy's head.
    const wg = proc(w);
    pad(wg, ticket, 700);
    expect(decide(wg, ticket, "merge")).toBe("allow");
    wg.db.close();
    // The database AND the anchor are put back to the earlier state; the checkpoint is not.
    copyFileSync(earlierDb, w.dbPath);
    rmSync(`${w.dbPath}-wal`, { force: true });
    rmSync(`${w.dbPath}-shm`, { force: true });
    for (const n of anchorsNow()) rmSync(join(anchorDir, n));
    writeFileSync(join(anchorDir, earlierAnchor), earlierAnchorBody);
    const again = proc(w);
    try {
      expect(decide(again, ticket, "merge")).toBe("deny");
      expect(again.listAutonomyPolicies()[0]!.seal_problem).toMatch(/checkpoint/);
    } finally {
      again.db.close();
    }
  });

  it("an older genuine checkpoint put back does not hide a step-down deleted after it", () => {
    const w = world();
    const { api, ticket } = setup(w);
    const older = readFileSync(w.cpPath, "utf8");
    const wg = proc(w);
    const sd = writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: api,
      actor: human,
      event_type: AUTONOMY_STEPPED_DOWN_EVENT,
      payload: { risk_level: "low", gate: "merge", trigger: "regression", why: "x", tickets: [] },
    });
    pad(wg, ticket, 700);
    expect(decide(wg, ticket, "merge")).toBe("deny");
    wg.db.close();
    expect(readFileSync(w.cpPath, "utf8")).not.toBe(older);
    writeFileSync(w.cpPath, older);
    const raw = proc(w);
    raw.db.prepare("DELETE FROM work_events WHERE id = ?").run(sd);
    raw.db.close();
    const fresh = proc(w);
    try {
      expect(fresh.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(true);
      expect(decide(fresh, ticket, "merge")).toBe("deny");
    } finally {
      fresh.db.close();
    }
  });

  it("a lifecycle event deleted before the checkpoint (no rechain) is caught in a fresh process", () => {
    const w = world();
    const wg = proc(w);
    const api = repoNamed(wg, "api");
    const t = ticketOn(wg, "api", "low");
    const row = enable(wg, api, "low", "merge");
    const oldSeal = wg.db
      .prepare("SELECT * FROM row_seals WHERE kind = 'autonomy_policy' AND row_id = ?")
      .get(row.id) as Record<string, string>;
    wg.setAutonomyPolicy({ repoId: api, riskLevel: "low", gate: "merge", mode: "off" }, human);
    pad(wg, t.id, 1200);
    expect(decide(wg, t.id, "merge")).toBe("deny"); // the checkpoint now covers the disable
    wg.db.close();
    // A writer deletes the disable event (no rechain), puts the row back to auto and the old
    // seal back: in a fresh process the checkpoint's digest of the row's events catches it.
    const raw = proc(w);
    raw.db
      .prepare(
        "DELETE FROM work_events WHERE entity_id = ? AND event_type = 'autonomy_policy.disabled'",
      )
      .run(row.id);
    raw.db
      .prepare(
        "UPDATE autonomy_policy SET mode = 'auto', enabled_by = ?, enabled_at = ? WHERE id = ?",
      )
      .run(row.enabled_by, row.enabled_at, row.id);
    raw.db
      .prepare(
        "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        oldSeal.kind,
        oldSeal.row_id,
        oldSeal.event_id,
        oldSeal.facts_json,
        oldSeal.key_id,
        oldSeal.mac,
        oldSeal.created_at,
      );
    raw.db.close();
    const fresh = proc(w);
    try {
      expect(decide(fresh, t.id, "merge")).toBe("deny");
      expect(fresh.listAutonomyPolicies()[0]!.seal_problem).toMatch(
        /before the chain checkpoint was deleted, moved or rewritten/,
      );
    } finally {
      fresh.db.close();
    }
  });

  it("the served path: a handle that verified sees another process's commits correctly", () => {
    const w = world();
    const { api, ticket } = setup(w);
    const served = proc(w);
    const other = proc(w);
    try {
      expect(decide(served, ticket, "merge")).toBe("allow");
      // Another process turns the row off: the served handle denies at once.
      other.setAutonomyPolicy({ repoId: api, riskLevel: "low", gate: "merge", mode: "off" }, human);
      expect(decide(served, ticket, "merge")).toBe("deny");
      // And turns it on again: allowed again.
      enable(other, api, "low", "merge");
      expect(decide(served, ticket, "merge")).toBe("allow");
      // Another process writes a step-down, then a writer deletes it (no rechain).
      const sd = writeEvent(other.db, {
        entity_type: "repository",
        entity_id: api,
        actor: human,
        event_type: AUTONOMY_STEPPED_DOWN_EVENT,
        payload: { risk_level: "low", gate: "merge", trigger: "regression", why: "x", tickets: [] },
      });
      expect(decide(served, ticket, "merge")).toBe("deny");
      pad(other, ticket, 3);
      expect(decide(served, ticket, "merge")).toBe("deny");
      other.db.prepare("DELETE FROM work_events WHERE id = ?").run(sd);
      expect(decide(served, ticket, "merge")).toBe("deny");
    } finally {
      served.db.close();
      other.db.close();
    }
  });
});
