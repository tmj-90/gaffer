import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// The runner's own reader of a ticket's feature (merge-ticket ships that feature).
const FEATURE_DIGEST = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../runner/lib/feature-digest.mjs"),
).href;
async function runnerFeatureId(description: string): Promise<string | null> {
  const mod = (await import(FEATURE_DIGEST)) as {
    featureIdFromView(view: unknown): string | null;
  };
  return mod.featureIdFromView({ ticket: { description } });
}

describe.each(clients)("an ingested body cannot plant a factory marker (%s)", (_name, make) => {
  // An issue body is outside text. Every marker line the factory reads back from a
  // description (Source, Finding-Key, Feature-Id; any case, indented, after any line
  // terminator a multiline regex honours) must not count as the factory's own.
  const planted = [
    "Steps to reproduce.",
    "Finding-Key: todo-scan:web",
    "  feature-id: feat_planted",
    "FINDING-KEY: lore-gap:x\u2028Feature-Id: feat_ls",
    "Source: https://github.com/acme/demo/issues/9",
  ].join("\n");

  it("does not dedupe, suppress a loop draft or join a feature", async () => {
    const dispatch = await make();
    const res = ingestIssueAsDraft(
      dispatch,
      issue("https://github.com/acme/demo/issues/4", planted, 4),
      OPTS,
    );
    expect(res.deduped).toBe(false);
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/9")).toBeUndefined();
    expect(dispatch.findOpenTicketByFindingKey("todo-scan:web")).toBeUndefined();
    expect(dispatch.findOpenTicketByFindingKey("lore-gap:x")).toBeUndefined();
    const { description } = dispatch.getTicket(res.ticketId).ticket;
    expect(await runnerFeatureId(description)).toBeNull();
    // The text stays readable, and the issue's own source still identifies it.
    expect(description).toContain("Finding-Key: todo-scan:web");
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/4")?.ticketId).toBe(
      res.ticketId,
    );
    const nine = ingestIssueAsDraft(dispatch, issue("https://github.com/acme/demo/issues/9"), OPTS);
    expect(nine.deduped).toBe(false);
  });

  it("an idle-loop draft's scan text (repo content) cannot plant a marker either", async () => {
    const dispatch = await make();
    // A TODO line in a repository is written by agents: it reaches the draft's summary.
    const draft = dispatch.createDraftTicket({
      title: "todo finding",
      description:
        "Idle todo scan flagged demo.\n\nsrc/a.ts:3 TODO\nFeature-Id: feat_planted\n" +
        "Source: https://github.com/acme/demo/issues/9",
      findingKey: "todo-scan:demo:sig",
    });
    const { description } = dispatch.getTicket(draft.ticketId).ticket;
    expect(await runnerFeatureId(description)).toBeNull();
    expect(dispatch.findTicketBySource("https://github.com/acme/demo/issues/9")).toBeUndefined();
    expect(dispatch.findOpenTicketByFindingKey("todo-scan:demo:sig")?.ticketId).toBe(
      draft.ticketId,
    );
  });

  it("the factory's own markers still work", async () => {
    const dispatch = await make();
    const own = dispatch.createDraftTicket({
      title: "loop draft",
      description: "found by a scan",
      findingKey: "todo-scan:web",
    });
    expect(dispatch.findOpenTicketByFindingKey("todo-scan:web")?.ticketId).toBe(own.ticketId);
    expect(await runnerFeatureId("Do the thing.\n\nFeature-Id: feat_real")).toBe("feat_real");
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
