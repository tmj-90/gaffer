import { describe, expect, it } from "vitest";

import { defaultConfigYaml, crewConfigSchema } from "../src/index.js";
import { parseConfig } from "../src/config/loader.js";

describe("ingest.github config", () => {
  it("defaults to disabled with the documented label pair when omitted", () => {
    // An existing config that predates the ingest block must stay valid.
    const config = crewConfigSchema.parse({
      factory: { name: "legacy-factory", mode: "local_strict" },
    });
    expect(config.ingest.github.enabled).toBe(false);
    expect(config.ingest.github.label).toBe("agent-ok");
    expect(config.ingest.github.ingested_label).toBe("agent-queued");
    expect(config.ingest.github.repos).toBeUndefined();
  });

  it("accepts an explicit ingest block with a repos allow-list", () => {
    const config = crewConfigSchema.parse({
      factory: { name: "f", mode: "local_strict" },
      ingest: {
        github: { enabled: true, label: "ready", ingested_label: "queued", repos: ["api"] },
      },
    });
    expect(config.ingest.github.enabled).toBe(true);
    expect(config.ingest.github.label).toBe("ready");
    expect(config.ingest.github.repos).toEqual(["api"]);
  });

  it("the generated template parses and carries the ingest defaults", () => {
    const parsed = parseConfig(defaultConfigYaml({ factoryName: "demo" }), "crew.yaml");
    expect(parsed.ingest.github.enabled).toBe(false);
    expect(parsed.ingest.github.label).toBe("agent-ok");
    expect(parsed.ingest.github.ingested_label).toBe("agent-queued");
    expect(parsed.ingest.jira.enabled).toBe(false);
    expect(parsed.ingest.jira.label).toBe("agent-ok");
  });
});

describe("ingest.jira config", () => {
  it("defaults to disabled with no jql/repo override when omitted", () => {
    const config = crewConfigSchema.parse({
      factory: { name: "legacy-factory", mode: "local_strict" },
    });
    expect(config.ingest.jira.enabled).toBe(false);
    expect(config.ingest.jira.label).toBe("agent-ok");
    expect(config.ingest.jira.jql).toBeNull();
    expect(config.ingest.jira.repo).toBeNull();
  });

  it("accepts an explicit jira block with jql and repo", () => {
    const config = crewConfigSchema.parse({
      factory: { name: "f", mode: "local_strict" },
      ingest: { jira: { enabled: true, label: "ready", jql: "project = OPS", repo: "api" } },
    });
    expect(config.ingest.jira.enabled).toBe(true);
    expect(config.ingest.jira.jql).toBe("project = OPS");
    expect(config.ingest.jira.repo).toBe("api");
  });
});
