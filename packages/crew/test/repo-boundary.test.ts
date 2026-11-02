/**
 * Onboarding reads stay inside the repository; remote URLs lose their userinfo
 * (external review #9, finding 3).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { scanRepoForOnboarding } from "../src/onboarding/onboardScan.js";
import {
  OutsideRepositoryError,
  outsideRepoReason,
  readRepoText,
  redactRemoteUrl,
} from "../src/safety/repoBoundary.js";

describe("redactRemoteUrl", () => {
  it("strips userinfo from URL forms and leaves ssh forms alone", () => {
    expect(redactRemoteUrl("https://bob:hunter2@github.com/acme/w.git")).toBe(
      "https://github.com/acme/w.git",
    );
    expect(redactRemoteUrl("http://token@host.example/x")).toBe("http://host.example/x");
    expect(redactRemoteUrl("ssh://git@github.com/acme/w.git")).toBe(
      "ssh://git@github.com/acme/w.git",
    );
    expect(redactRemoteUrl("git@github.com:acme/w.git")).toBe("git@github.com:acme/w.git");
    expect(redactRemoteUrl("https://github.com/acme/w")).toBe("https://github.com/acme/w");
    expect(redactRemoteUrl(null)).toBeNull();
  });

  it("drops an ssh password and a password holding a raw @, keeping the ssh login", () => {
    expect(redactRemoteUrl("ssh://git:s3cret@host/r.git")).toBe("ssh://git@host/r.git");
    expect(redactRemoteUrl("git+ssh://git:s3cret@host/r")).toBe("git+ssh://git@host/r");
    expect(redactRemoteUrl("https://u:p@ss@host/x")).toBe("https://host/x");
  });
});

describe("repository boundary", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "crew-boundary-")));
    root = join(base, "repo");
    outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.json"), '{"scripts":{"test":"OUTSIDE_MARK"}}');
  });
  afterEach(() => rmSync(join(root, ".."), { recursive: true, force: true }));

  it("refuses a symlink that leaves the repository, with a reason", () => {
    symlinkSync(join(outside, "secret.json"), join(root, "package.json"));
    expect(outsideRepoReason(root, "package.json")).toMatch(
      /package\.json is a symlink to a file outside the repository/,
    );
    expect(() => readRepoText(root, "package.json")).toThrow(OutsideRepositoryError);
  });

  it("reads a file (or a symlink) that stays inside", () => {
    writeFileSync(join(root, "real.txt"), "inside");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    expect(readRepoText(root, "link.txt")).toBe("inside");
  });

  it("the onboarding scan neither reads an outside manifest nor keeps a remote's password", () => {
    symlinkSync(join(outside, "secret.json"), join(root, "package.json"));
    const scan = scanRepoForOnboarding(
      root,
      new DryRunGitAdapter({ remoteUrl: "https://bob:hunter2@git.example.com/acme/w.git" }),
    );
    expect(JSON.stringify(scan)).not.toContain("OUTSIDE_MARK");
    expect(scan.remoteUrl).toBe("https://git.example.com/acme/w.git");
  });
});
