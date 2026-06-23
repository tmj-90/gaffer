import { describe, expect, it } from "vitest";

import {
  recordDeliveryArtifactInput,
  recordRepoDeliveryInput,
  registerRepoInput,
} from "../src/domain/schemas.js";
import { recordDeliveryArtifactBody, recordRepoDeliveryBody } from "../src/api/schemas.js";

/**
 * P1-A — git option-injection via an unvalidated branch / default-branch.
 *
 * A `branch_name` / `default_branch` like `--output=…`, `-`, `a..b`, `a b`, or a
 * value containing a newline must be REJECTED at the schema boundary, because the
 * value is later handed to git as a positional ref where a leading `-` would be
 * option-parsed (and `..` is a ref-range). Real refs (`gaffer/ticket-12-x`,
 * `main`) must still pass.
 */

/** Values that must be rejected wherever a git ref is accepted. */
const MALICIOUS_REFS = [
  "--output=x",
  "--upload-pack=touch /tmp/pwn",
  "-",
  "-rf",
  "a..b",
  "a b",
  "feature\nrm -rf",
  "..",
  "../escape",
  "with\ttab",
] as const;

/** Values that are legitimate git refs and must pass. */
const VALID_REFS = ["gaffer/ticket-12-x", "main", "release/v1.2.3", "fix_bug-7"] as const;

describe("P1-A: git-ref-safe validation — registerRepoInput.default_branch", () => {
  for (const bad of MALICIOUS_REFS) {
    it(`rejects default_branch ${JSON.stringify(bad)}`, () => {
      const res = registerRepoInput.safeParse({ name: "api", default_branch: bad });
      expect(res.success).toBe(false);
    });
  }

  for (const good of VALID_REFS) {
    it(`accepts default_branch ${JSON.stringify(good)}`, () => {
      const res = registerRepoInput.safeParse({ name: "api", default_branch: good });
      expect(res.success).toBe(true);
    });
  }

  it("defaults default_branch to main when omitted (and main is ref-safe)", () => {
    const res = registerRepoInput.safeParse({ name: "api" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.default_branch).toBe("main");
  });
});

describe("P1-A: git-ref-safe validation — branch_name (domain schemas)", () => {
  for (const bad of MALICIOUS_REFS) {
    it(`recordDeliveryArtifactInput rejects branch_name ${JSON.stringify(bad)}`, () => {
      const res = recordDeliveryArtifactInput.safeParse({ ticket_id: "t1", branch_name: bad });
      expect(res.success).toBe(false);
    });

    it(`recordRepoDeliveryInput rejects branch_name ${JSON.stringify(bad)}`, () => {
      const res = recordRepoDeliveryInput.safeParse({
        ticket_id: "t1",
        repo_id: "r1",
        branch_name: bad,
      });
      expect(res.success).toBe(false);
    });
  }

  for (const good of VALID_REFS) {
    it(`recordDeliveryArtifactInput accepts branch_name ${JSON.stringify(good)}`, () => {
      const res = recordDeliveryArtifactInput.safeParse({ ticket_id: "t1", branch_name: good });
      expect(res.success).toBe(true);
    });
  }
});

describe("P1-A: git-ref-safe validation — branch_name (API schemas)", () => {
  for (const bad of MALICIOUS_REFS) {
    it(`recordDeliveryArtifactBody rejects branch_name ${JSON.stringify(bad)}`, () => {
      const res = recordDeliveryArtifactBody.safeParse({ branch_name: bad });
      expect(res.success).toBe(false);
    });

    it(`recordRepoDeliveryBody rejects branch_name ${JSON.stringify(bad)}`, () => {
      const res = recordRepoDeliveryBody.safeParse({ repo_id: "r1", branch_name: bad });
      expect(res.success).toBe(false);
    });
  }

  for (const good of VALID_REFS) {
    it(`recordDeliveryArtifactBody accepts branch_name ${JSON.stringify(good)}`, () => {
      const res = recordDeliveryArtifactBody.safeParse({ branch_name: good });
      expect(res.success).toBe(true);
    });
  }
});
