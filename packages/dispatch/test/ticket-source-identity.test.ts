import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";
import {
  canonicalSourceUrl,
  descriptionHasFindingKey,
  descriptionHasSource,
  formatSourceMarker,
} from "../src/util/ticketMarkers.js";

const sys: Actor = { type: "system", id: "ingest" };

describe("ticket markers: the one exact source matcher", () => {
  it("canonicalises scheme and host case, trailing slash, fragment and user info", () => {
    expect(canonicalSourceUrl("HTTPS://user:pw@GitHub.COM:443/acme/Demo/issues/5/#c1")).toBe(
      "https://github.com/acme/Demo/issues/5",
    );
    expect(canonicalSourceUrl("https://x.test/a?id=1")).toBe("https://x.test/a?id=1");
    expect(canonicalSourceUrl("  not a url ")).toBe("not a url");
  });

  it("matches the last whole marker line exactly, never a substring", () => {
    const d = `body\nSource: https://github.com/a/b/issues/1\n\nSource: https://github.com/a/b/issues/10`;
    expect(descriptionHasSource(d, "https://github.com/a/b/issues/10")).toBe(true);
    expect(descriptionHasSource(d, "https://github.com/a/b/issues/1")).toBe(false);
    expect(descriptionHasSource("prefix Source: https://h/x", "https://h/x")).toBe(false);
    expect(descriptionHasFindingKey("d\n\nFinding-Key: loop:web-app", "loop:web")).toBe(false);
    expect(descriptionHasFindingKey("d\n\nFinding-Key: loop:web-app", "loop:web-app")).toBe(true);
  });
});

describe("Dispatch.createDraftTicket with a sourceUrl", () => {
  it("returns the existing ticket for the same canonical source instead of creating", () => {
    const wg = Dispatch.open(":memory:");
    const url = "https://github.com/acme/demo/issues/1";
    const ten = wg.createDraftTicket(
      { title: "ten", description: `b\n\n${formatSourceMarker(`${url}0`)}`, sourceUrl: `${url}0` },
      sys,
    );
    const one = wg.createDraftTicket(
      { title: "one", description: `b\n\n${formatSourceMarker(url)}`, sourceUrl: url },
      sys,
    );
    expect(one.ticketId).not.toBe(ten.ticketId);
    expect(one.deduped).toBeUndefined();
    const again = wg.createDraftTicket(
      { title: "one again", description: `b\n\n${formatSourceMarker(url)}/`, sourceUrl: `${url}/` },
      sys,
    );
    expect(again).toEqual({ ticketId: one.ticketId, number: one.number, deduped: true });
    expect(wg.findTicketBySource("HTTPS://GITHUB.COM/acme/demo/issues/1")?.ticketId).toBe(
      one.ticketId,
    );
  });

  it("refuses a description that does not record the source it claims", () => {
    const wg = Dispatch.open(":memory:");
    expect(() =>
      wg.createDraftTicket(
        { title: "x", description: "no marker", sourceUrl: "https://h/issues/1" },
        sys,
      ),
    ).toThrow(DispatchError);
  });
});
