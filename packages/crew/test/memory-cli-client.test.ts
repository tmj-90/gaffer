/**
 * CLI-backed Memory write client (the onboard flush sink).
 *
 * Asserts that the memory CLI bridge:
 *   - emits the correct `digest set` argv (all sections + source, stack defaulted);
 *   - emits the correct `feature add` argv (repo positional, status, provenance,
 *     optional scope-node);
 *   - parses a `features <repo>` human listing into repo+name de-dupe pairs;
 *   - de-dupes features by repo+name on re-onboard when wired through
 *     {@link flushRepoUnderstanding}, so a re-run never duplicates a feature;
 *   - surfaces a non-zero CLI exit as MEMORY_UNAVAILABLE so the flush degrades.
 *
 * The spawn is fully stubbed via the injected {@link CliRunner} — no CLI on disk.
 */
import { describe, expect, it } from "vitest";

import {
  CliMemoryClient,
  cliConfigFromEnv,
  parseFeatureNames,
  type CliRunResult,
  type CliRunner,
} from "../src/memory/cliClient.js";
import { flushRepoUnderstanding } from "../src/memory/prefetch.js";
import type { FeatureInput, RepoDigestInput } from "../src/memory/client.js";

/** A runner that records every argv and replies from a queue (or a default ok). */
function recordingRunner(replies: Partial<Record<string, CliRunResult>> = {}): {
  runner: CliRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CliRunner = (args) => {
    calls.push([...args]);
    const verb = `${args[0]} ${args[1]}`; // e.g. "digest set", "feature add"
    const single = args[0]; // e.g. "features"
    return replies[verb] ?? replies[single ?? ""] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

const digest: RepoDigestInput = {
  repo: "acme-bridge",
  overview: "A commerce bridge.",
  structure: "src/, test/",
  conventions: "pnpm test",
  stack: null,
  source: "onboard",
};

function feature(name: string, scopeNode?: string): FeatureInput {
  return {
    repo: "acme-bridge",
    name,
    summary: `${name} summary`,
    status: "shipped",
    area: "core",
    provenance: "onboard",
    ...(scopeNode ? { scopeNode } : {}),
  };
}

describe("cliConfigFromEnv", () => {
  it("resolves cliBin + db from the environment", () => {
    expect(cliConfigFromEnv({ MEMORY_CLI_BIN: "/bin/lg.js", MEMORY_DB: "/db.sqlite" })).toEqual({
      cliBin: "/bin/lg.js",
      db: "/db.sqlite",
    });
  });

  it("returns null when either piece is missing", () => {
    expect(cliConfigFromEnv({ MEMORY_CLI_BIN: "/bin/lg.js" })).toBeNull();
    expect(cliConfigFromEnv({ MEMORY_DB: "/db.sqlite" })).toBeNull();
    expect(cliConfigFromEnv({})).toBeNull();
  });
});

describe("parseFeatureNames", () => {
  it("extracts feature names from a human `features` listing", () => {
    const stdout = [
      "Features for acme-bridge: 3",
      "",
      "SHIPPED (3)",
      "  [shipped] Cart  (ab12cd34)",
      "  [shipped] Price feed  @Pricing  (ef56gh78)",
      "      a summary line that must be ignored",
      "  [shipped] Billing engine  (Core)  (ij90kl12)",
    ].join("\n");

    const names = parseFeatureNames(stdout, "acme-bridge").map((f) => f.name);
    expect(names).toEqual(["Cart", "Price feed", "Billing engine"]);
  });

  it("returns [] for the empty listing", () => {
    expect(parseFeatureNames("memory: no features for 'acme-bridge'", "acme-bridge")).toEqual([]);
  });
});

describe("CliMemoryClient write verbs", () => {
  it("builds the digest set argv with every section + source, defaulting a null stack", async () => {
    const { runner, calls } = recordingRunner();
    const client = new CliMemoryClient({ cliBin: "/lg.js", db: "/db", runner });

    const result = await client.updateRepoDigest(digest);

    expect(result).toEqual({ repo: "acme-bridge", status: "updated" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "digest",
      "set",
      "acme-bridge",
      "--overview",
      "A commerce bridge.",
      "--structure",
      "src/, test/",
      "--conventions",
      "pnpm test",
      "--source",
      "onboard",
      "--stack",
      "unknown",
    ]);
  });

  it("builds the feature add argv as a repo positional with optional scope-node", async () => {
    const { runner, calls } = recordingRunner();
    const client = new CliMemoryClient({ cliBin: "/lg.js", db: "/db", runner });

    await client.addFeature(feature("Cart"));
    await client.addFeature(feature("Price feed", "Pricing"));

    expect(calls[0]).toEqual([
      "feature",
      "add",
      "acme-bridge",
      "--name",
      "Cart",
      "--summary",
      "Cart summary",
      "--status",
      "shipped",
      "--provenance",
      "onboard",
    ]);
    expect(calls[1]).toContain("--scope-node");
    expect(calls[1]?.at(-1)).toBe("Pricing");
  });

  it("parses listFeatures output and surfaces a non-zero exit as unavailable", async () => {
    const okClient = new CliMemoryClient({
      cliBin: "/lg.js",
      db: "/db",
      runner: recordingRunner({
        features: { status: 0, stdout: "  [shipped] Cart  (ab12cd34)\n", stderr: "" },
      }).runner,
    });
    expect((await okClient.listFeatures("acme-bridge")).map((f) => f.name)).toEqual(["Cart"]);

    const badClient = new CliMemoryClient({
      cliBin: "/lg.js",
      db: "/db",
      runner: recordingRunner({ features: { status: 1, stdout: "", stderr: "boom" } }).runner,
    });
    await expect(badClient.listFeatures("acme-bridge")).rejects.toThrow(
      /MEMORY_UNAVAILABLE|error/i,
    );
  });

  it("propagates a non-zero digest set exit as a write failure", async () => {
    const client = new CliMemoryClient({
      cliBin: "/lg.js",
      db: "/db",
      runner: recordingRunner({ "digest set": { status: 2, stdout: "", stderr: "bad" } }).runner,
    });
    await expect(client.updateRepoDigest(digest)).rejects.toThrow();
  });
});

describe("flushRepoUnderstanding through the CLI client de-dupes on re-onboard", () => {
  it("writes the digest + every feature first, then skips already-recorded features", async () => {
    // A stateful stub CLI: `feature add` remembers names; `features` lists them
    // back in the real human format so the client's de-dupe pre-check sees them.
    const stored: string[] = [];
    const runner: CliRunner = (args) => {
      if (args[0] === "feature" && args[1] === "add") {
        const nameIdx = args.indexOf("--name");
        if (nameIdx >= 0) stored.push(String(args[nameIdx + 1]));
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "features") {
        const body = stored.map((n, i) => `  [shipped] ${n}  (id${i})`).join("\n");
        return { status: 0, stdout: stored.length ? body : "no features", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" }; // digest set
    };
    const client = new CliMemoryClient({ cliBin: "/lg.js", db: "/db", runner });
    const understanding = {
      digest,
      features: [feature("Cart"), feature("Price feed", "Pricing")],
    };

    const first = await flushRepoUnderstanding(client, understanding);
    expect(first.digestWritten).toBe(true);
    expect(first.featuresAdded).toBe(2);
    expect(first.featuresSkipped).toBe(0);
    expect(stored).toEqual(["Cart", "Price feed"]);

    // Re-onboard: same understanding → digest upserts, every feature already
    // recorded → all skipped, none duplicated.
    const second = await flushRepoUnderstanding(client, understanding);
    expect(second.digestWritten).toBe(true);
    expect(second.featuresAdded).toBe(0);
    expect(second.featuresSkipped).toBe(2);
    expect(stored).toEqual(["Cart", "Price feed"]); // unchanged — no duplicate adds
  });
});
