/**
 * Clock abstraction so time-dependent logic (claim expiry, heartbeats) is
 * deterministic in tests. Timestamps are ISO-8601 UTC strings, matching the
 * TEXT columns in the schema.
 */
export interface Clock {
  now(): string;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/** ISO timestamp `seconds` from `fromIso` (default: now on the given clock). */
export function isoPlusSeconds(seconds: number, fromIso: string): string {
  return new Date(new Date(fromIso).getTime() + seconds * 1000).toISOString();
}

/** Mutable clock for tests — advance time explicitly. */
export class TestClock implements Clock {
  private current: number;
  constructor(startIso = "2026-01-01T00:00:00.000Z") {
    this.current = new Date(startIso).getTime();
  }
  now(): string {
    return new Date(this.current).toISOString();
  }
  nowMs(): number {
    return this.current;
  }
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}
