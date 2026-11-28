/**
 * The research URL rules, dispatch's twin (util/researchUrl.ts), against the ONE vector
 * file the runner's rules run too (runner/test/fixtures/research-url-vectors.json): the
 * same verdict and, for a refusal, the same rule, for every row.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkResearchUrl, secretLike } from "../src/util/researchUrl.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const { vectors } = JSON.parse(
  readFileSync(
    resolve(HERE, "..", "..", "..", "runner", "test", "fixtures", "research-url-vectors.json"),
    "utf8",
  ),
) as { vectors: Array<{ url: string; ok: boolean; code?: string; why: string }> };

describe("research URL rules (dispatch twin)", () => {
  it("reads at least 150 shared vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(150);
  });
  it.each(vectors.map((v) => [v.url.slice(0, 80), v] as const))("%s", (_label, v) => {
    const r = checkResearchUrl(v.url);
    if (v.ok) expect(r, v.why).toMatchObject({ ok: true });
    else expect(r, v.why).toMatchObject({ ok: false, code: v.code });
  });
  it("never throws on odd input and keeps the secret shapes", () => {
    for (const bad of [undefined, null, 1, {}, []]) expect(checkResearchUrl(bad).ok).toBe(false);
    expect(secretLike("a8F3kL9qZ2xW7pR4tY6uI0oP5sD1fG3hJ8kL2zX4")).toBe(true);
    expect(secretLike("how-to-build-a-workout-tracker-in-react-and-node-2024")).toBe(false);
  });
});
