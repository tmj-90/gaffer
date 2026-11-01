import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brownfieldEpicRepo, EPIC_FEATURE_CMD_ENV } from "../src/api/epicFeature.js";
import type { CreateEpicBody } from "../src/api/schemas.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

// The BROWNFIELD epic → feature(`building`) hook. runner/bin/epic-feature.mjs used
// to have no caller: confirming a brownfield epic in the dashboard (POST /epics)
// never moved the memory feature ledger. POST /epics now spawns
// DISPATCH_EPIC_FEATURE_CMD (detached, no shell) when every ticket targets ONE
// existing registered repo.

const human: Actor = { type: "human", id: "tom" };

function seed(): Dispatch {
  const wg = Dispatch.open(":memory:", new TestClock());
  wg.registerRepository({ name: "taskapi", local_path: "/tmp/taskapi" }, human);
  wg.registerRepository({ name: "web", local_path: "/tmp/web" }, human);
  return wg;
}

const body = (tickets: CreateEpicBody["tickets"]): CreateEpicBody => ({
  epic: { name: "Streaks", description: "Daily streaks" },
  tickets,
});

describe("brownfieldEpicRepo", () => {
  it("names the repo when every ticket targets the same registered repo", () => {
    const wg = seed();
    const res = {
      epicNodeId: "n",
      deferredRepoLinks: 0,
      ticketNumbers: [],
      acceptanceTicketNumber: null,
      agreedRequirements: 0,
      testableTickets: 0,
    };
    const repoId = wg.listRepositories(true).find((r) => r.name === "taskapi")!.id;
    expect(
      brownfieldEpicRepo(
        wg,
        body([
          { title: "a", repo: "taskapi" },
          { title: "b", repo: repoId },
        ]),
        res,
      ),
    ).toBe("taskapi");
  });

  it("is null for mixed-repo, repo-less, bootstrap or greenfield (deferred) plans", () => {
    const wg = seed();
    const res = {
      epicNodeId: "n",
      deferredRepoLinks: 0,
      ticketNumbers: [],
      acceptanceTicketNumber: null,
      agreedRequirements: 0,
      testableTickets: 0,
    };
    expect(
      brownfieldEpicRepo(
        wg,
        body([
          { title: "a", repo: "taskapi" },
          { title: "b", repo: "web" },
        ]),
        res,
      ),
    ).toBeNull();
    expect(
      brownfieldEpicRepo(wg, body([{ title: "a", repo: "taskapi" }, { title: "b" }]), res),
    ).toBeNull();
    expect(
      brownfieldEpicRepo(wg, body([{ title: "a", repo: "taskapi", bootstrap: true }]), res),
    ).toBeNull();
    expect(
      brownfieldEpicRepo(wg, body([{ title: "a", repo: "newapp" }]), {
        ...res,
        deferredRepoLinks: 1,
      }),
    ).toBeNull();
  });
});

describe("POST /epics spawns the brownfield feature hook", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "epic-feature-hook-"));
    saved = process.env[EPIC_FEATURE_CMD_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[EPIC_FEATURE_CMD_ENV];
    else process.env[EPIC_FEATURE_CMD_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  async function postEpic(wg: Dispatch, payload: CreateEpicBody): Promise<number> {
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/epics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.status;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async function waitFor(path: string): Promise<boolean> {
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(path) && readFileSync(path, "utf8").length > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  function stub(): { out: string } {
    const out = join(dir, "argv.json");
    const script = join(dir, "hook.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.DISPATCH_API_TOKEN ?? null }));\n`,
    );
    process.env[EPIC_FEATURE_CMD_ENV] = JSON.stringify([process.execPath, script]);
    return { out };
  }

  it("a brownfield epic triggers the hook with repo, epic ref, name and summary as argv", async () => {
    const { out } = stub();
    const wg = seed();
    const status = await postEpic(
      wg,
      body([
        { title: "streak model", repo: "taskapi", acceptanceCriteria: ["stores streaks"] },
        {
          title: "streak api",
          repo: "taskapi",
          acceptanceCriteria: ["GET /streaks"],
          dependsOn: [0],
        },
      ]),
    );
    expect(status).toBe(201);
    expect(await waitFor(out)).toBe(true);
    const got = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; token: string | null };
    const epicNode = wg.listScopeNodes().find((n) => n.name === "Streaks");
    expect(got.argv).toEqual([
      "--repo",
      "taskapi",
      "--epic",
      epicNode!.id,
      "--name",
      "Streaks",
      "--summary",
      "Daily streaks",
    ]);
    expect(got.token).toBeNull();
    wg.db.close();
  });

  it("a greenfield / mixed epic does NOT trigger the hook", async () => {
    const { out } = stub();
    const wg = seed();
    expect(
      await postEpic(
        wg,
        body([
          { title: "a", repo: "taskapi", acceptanceCriteria: ["x"] },
          { title: "b", repo: "web", acceptanceCriteria: ["y"] },
        ]),
      ),
    ).toBe(201);
    expect(
      await postEpic(wg, body([{ title: "c", repo: "brand-new", acceptanceCriteria: ["z"] }])),
    ).toBe(201);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(out)).toBe(false);
    wg.db.close();
  });
});
