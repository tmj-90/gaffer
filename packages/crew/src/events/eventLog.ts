import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { redactDeep } from "../safety/redaction.js";
import type { Clock } from "../util/clock.js";
import { systemClock } from "../util/clock.js";

export interface RuntimeEvent {
  type: string;
  at: string;
  payload?: Record<string, unknown>;
}

/**
 * Crew's runtime event stream, separate from Dispatch's domain log.
 * In-memory by default and observable in tests; optionally mirrored to a JSONL
 * file. Payloads are deep-redacted so no secret can land in the log.
 */
export class EventLog {
  readonly events: RuntimeEvent[] = [];

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly opts: { filePath?: string; redact?: boolean } = {},
  ) {}

  record(type: string, payload?: Record<string, unknown>): RuntimeEvent {
    const shouldRedact = this.opts.redact ?? true;
    const event: RuntimeEvent = {
      type,
      at: this.clock.now(),
      ...(payload ? { payload: shouldRedact ? redactDeep(payload) : payload } : {}),
    };
    this.events.push(event);
    if (this.opts.filePath) {
      this.appendToFile(event, this.opts.filePath);
    }
    return event;
  }

  /** Event types recorded so far, in order — handy for asserting loop paths. */
  types(): string[] {
    return this.events.map((e) => e.type);
  }

  private appendToFile(event: RuntimeEvent, filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
