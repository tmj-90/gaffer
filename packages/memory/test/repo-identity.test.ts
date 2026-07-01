/**
 * Repo identity normalisation — the fix for the repo_key/canonical fragility.
 *
 * Pins:
 *   - every git remote URL form collapses to `host/owner/repo` (lowercased)
 *   - ssh, https, git://, ssh://+port, scp-like all agree
 *   - the no-remote path fallback keeps its case + strips trailing slash
 *   - canonicalizeRepo is idempotent
 *   - repoKey(sshForm) === repoKey(httpsForm) — the actual bug
 */
import { describe, expect, it } from "vitest";

import { canonicalizeRepo } from "../src/core/repoIdentity.js";
import { repoKey } from "../src/core/fileCards.js";

describe("canonicalizeRepo — git remote URL forms", () => {
  const cases: Array<[string, string]> = [
    ["git@github.com:acme/widget.git", "github.com/acme/widget"],
    ["https://github.com/acme/widget.git", "github.com/acme/widget"],
    ["https://github.com/acme/widget", "github.com/acme/widget"],
    ["http://github.com/acme/widget.git", "github.com/acme/widget"],
    ["ssh://git@github.com/acme/widget.git", "github.com/acme/widget"],
    ["ssh://git@github.com:22/acme/widget", "github.com/acme/widget"],
    ["git://github.com/acme/widget.git", "github.com/acme/widget"],
    ["https://user:token@github.com/acme/widget.git", "github.com/acme/widget"],
    ["https://github.com/acme/widget.git/", "github.com/acme/widget"],
    // Case-folding of the host (and, deliberately, the whole remote form).
    ["git@GitHub.com:Acme/Widget.git", "github.com/acme/widget"],
    // A self-hosted GitLab-style nested path collapses too.
    ["git@gitlab.example.com:group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(canonicalizeRepo(input)).toBe(expected);
    });
  }

  it("is idempotent for every remote form", () => {
    for (const [input] of cases) {
      const once = canonicalizeRepo(input);
      expect(canonicalizeRepo(once)).toBe(once);
    }
  });
});

describe("canonicalizeRepo — no-remote path fallback", () => {
  it("strips a trailing slash but preserves case (paths are case-sensitive)", () => {
    expect(canonicalizeRepo("/Users/dev/git/Widget/")).toBe("/Users/dev/git/Widget");
    expect(canonicalizeRepo("/Users/dev/git/Widget")).toBe("/Users/dev/git/Widget");
  });

  it("normalises a file:// URL to its path", () => {
    expect(canonicalizeRepo("file:///Users/dev/git/widget/")).toBe("/Users/dev/git/widget");
  });

  it("is idempotent for the path fallback", () => {
    const p = canonicalizeRepo("/Users/dev/git/widget/");
    expect(canonicalizeRepo(p)).toBe(p);
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(canonicalizeRepo("")).toBe("");
    expect(canonicalizeRepo("   ")).toBe("");
  });
});

describe("repoKey — the actual bug: ssh and https must produce the SAME key", () => {
  it("ssh, https, and bare host forms of a repo all hash to one key", () => {
    const ssh = repoKey("git@github.com:acme/widget.git");
    const https = repoKey("https://github.com/acme/widget.git");
    const bare = repoKey("github.com/acme/widget");
    expect(ssh).toBe(https);
    expect(https).toBe(bare);
  });

  it("different repos still get distinct keys", () => {
    expect(repoKey("git@github.com:acme/widget.git")).not.toBe(
      repoKey("git@github.com:acme/gizmo.git"),
    );
  });

  it("the normalised key matches sha256(host/owner/repo)", () => {
    // Cross-checked against `printf 'github.com/acme/widget' | shasum -a 256`.
    expect(repoKey("git@github.com:acme/widget.git")).toBe(
      "8ac5bc08a41714b439de011cd921e0dddce459b45787709cfa4e295aa228f879",
    );
  });
});
