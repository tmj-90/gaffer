/**
 * Clock abstraction so time-dependent logic (loop timestamps, branch names,
 * event ordering) is deterministic in tests. Timestamps are ISO-8601 UTC
 * strings.
 */
export interface Clock {
  now(): string;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

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

/** A short calendar-date stamp (YYYY-MM-DD) for branch/ticket naming. */
export function dateStamp(clock: Clock): string {
  return clock.now().slice(0, 10);
}
