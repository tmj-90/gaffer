import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RealDispatchClient } from "../src/dispatch/realClient.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import type { DispatchClient } from "../src/dispatch/client.js";
import { ingestIssueAsDraft, type NormalizedIssue } from "../src/ingest/core.js";

/**
 * Issue ingest dedupes on an EXACT canonical source identity. A substring match
 * made `.../issues/1` dedupe against an existing `.../issues/10` ticket and
 * silently dropped the new issue. Every case runs against the fake client AND
 * a real Dispatch so the two cannot drift.
 */

const OPTS = { evidenceSummary: "ingested" };

function issue(url: string, body: string | null = "Body.", number = 1): NormalizedIssue {
  return { number, title: `Issue ${url}`, body, url };
}

type Make = () => Promise<DispatchClient>;
const clients: Array<[string, Make]> = [
  ["fake", async () => new FakeDispatchClient()],
  ["real dispatch", async () => RealDispatchClient.open(":memory:")],
];

describe.each(clients)("ingest source identity (%s)", (_name, make) => {
  it("issues/1 does not dedupe against an existing issues/10", async () => {
    const dispatch = await make();
    const ten = ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/10"), OPTS);
    expect(ten.deduped).toBe(false);
    const one = ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/1"), OPTS);
    expect(one.deduped).toBe(false);
    expect(one.ticketId).not.toBe(ten.ticketId);
  });

  it("issues/1 does not dedupe against an existing issues/100", async () => {
    const dispatch = await make();
    ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/100"), OPTS);
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/1")).toBeUndefined();
    const one = ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/1"), OPTS);
    expect(one.deduped).toBe(false);
  });

  it("a Jira PROJ-1 does not dedupe against PROJ-10", async () => {
    const dispatch = await make();
    const base = "https://acme.atlassian.net/rest/api/2/issue/";
    ingestIssueAsDraft(dispatch, issue(`${base}PROJ-10`), OPTS);
    const one = ingestIssueAsDraft(dispatch, issue(`${base}PROJ-1`), OPTS);
    expect(one.deduped).toBe(false);
    // and the same issue again still dedupes
    expect(ingestIssueAsDraft(dispatch, issue(`${base}PROJ-1`), OPTS)).toEqual({
      ticketId: one.ticketId,
      deduped: true,
    });
  });

  it("a source-like line inside an issue body neither dedupes nor mis-attributes", async () => {
    const dispatch = await make();
    const body = [
      "Repro steps below.",
      "Source: https://github.com/acme/demo/issues/1",
      "More text after the quoted line.",
    ].join("\n");
    const two = ingestIssueAsDraft(
      dispatch,
      issue("https://github.com/acme/demo/issues/2", body, 2),
      OPTS,
    );
    expect(two.deduped).toBe(false);
    // The ticket for issue 2 is not issue 1's ticket.
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/1")).toBeUndefined();
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/2")?.ticketId).toBe(
      two.ticketId,
    );
    const one = ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/1"), OPTS);
    expect(one.deduped).toBe(false);
  });

  it("an issue body whose last line looks like a marker is not the identity", async () => {
    const dispatch = await make();
    const body = "Quoting: \nSource: https://github.com/acme/demo/issues/9";
    const three = ingestIssueAsDraft(
      dispatch,
      issue("https://github.com/acme/demo/issues/3", body, 3),
      OPTS,
    );
    expect(three.deduped).toBe(false);
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/9")).toBeUndefined();
  });

  it("scheme and host case, a trailing slash and a fragment name the same issue", async () => {
    const dispatch = await make();
    const first = ingestIssueAsDraft(
      dispatch,
      issue("https://github.com/acme/demo/issues/5"),
      OPTS,
    );
    for (const variant of [
      "HTTPS://GitHub.COM/acme/demo/issues/5",
      "https://github.com/acme/demo/issues/5/",
      "https://github.com/acme/demo/issues/5#issuecomment-1",
    ]) {
      expect(ingestIssueAsDraft(dispatch, issue(variant), OPTS)).toEqual({
        ticketId: first.ticketId,
        deduped: true,
      });
    }
    // The path is case-sensitive and a different number is a different issue.
    expect(
      ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/50"), OPTS),
    ).toMatchObject({ deduped: false });
  });

  it("a ticket written with the old marker format keeps deduping", async () => {
    const dispatch = await make();
    // Exactly what ingest wrote before: body, labels line, then the raw Source line.
    const url = "https://github.com/acme/demo/issues/7";
    const old = dispatch.createDraftTicket({
      title: "Old ingest",
      description: `Brute-force protection.\n\nLabels: bug\n\nSource: ${url}`,
    });
    expect(ingestIssueAsDraft(dispatch, issue(url), OPTS)).toEqual({
      ticketId: old.ticketId,
      deduped: true,
    });
    // ...and an old-format ticket for issues/70 does not swallow issues/7's sibling issues/71.
    dispatch.createDraftTicket({
      title: "Old ingest 70",
      description: `x\n\nSource: https://github.com/acme/demo/issues/70`,
    });
    expect(
      ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/71"), OPTS),
    ).toMatchObject({ deduped: false });
  });

  it("a finding key that is a prefix of another open ticket's key is not a match", async () => {
    const dispatch = await make();
    dispatch.createDraftTicket({
      title: "web-app finding",
      description: "d",
      findingKey: "todo-scan:web-app",
    });
    dispatch.createDraftTicket({ title: "F10", description: "d", findingKey: "feature:web:F10" });
    expect(dispatch.findOpenTicketByFindingKey("todo-scan:web")).toBeUndefined();
    expect(dispatch.findOpenTicketByFindingKey("feature:web:F1")).toBeUndefined();
    expect(dispatch.findOpenTicketByFindingKey("feature:web:F10")).toBeDefined();
  });
});

describe("concurrent double ingest against one Dispatch database", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("two ingests that both miss the lookup still create one ticket", async () => {
    dir = mkdtempSync(join(tmpdir(), "crew-ingest-race-"));
    const db = join(dir, "dispatch.sqlite");
    const a = await RealDispatchClient.open(db);
    const b = await RealDispatchClient.open(db);
    const src = issue("https://github.com/acme/demo/issues/42");

    // Interleave: ingest A's lookup misses, then ingest B runs to completion on
    // its own connection, then A goes on to create. Only Dispatch can stop the
    // second create; the lookup A already did is stale.
    let raced = false;
    const racingA: DispatchClient = new Proxy(a, {
      get(target, prop, receiver) {
        if (prop === "findTicketBySource") {
          return (url: string) => {
            const seen = target.findTicketBySource(url);
            if (!raced) {
              raced = true;
              ingestIssueAsDraft(b, src, OPTS);
            }
            return seen;
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });

    const resA = ingestIssueAsDraft(racingA, src, OPTS);
    expect(raced).toBe(true);
    expect(resA.deduped).toBe(true);
    expect(b.findTicketBySource(src.url)?.ticketId).toBe(resA.ticketId);
    // Exactly one ticket exists in the database.
    const { Dispatch } = await import("dispatch");
    const raw = Dispatch.open(db) as unknown as { list(): unknown[] };
    expect(raw.list()).toHaveLength(1);
  });
});
