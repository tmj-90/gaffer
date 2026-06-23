/**
 * `memory suggest --from-commit` — pure helpers. The CLI wrapper shells
 * out to git; these tests pin the parsing / URL-derivation / field-shaping
 * contracts without a git repo.
 */
import { describe, expect, it } from "vitest";

import {
  commitToDraftFields,
  commitUrlFromRemote,
  FIELD_SEP,
  parseCommitShow,
} from "../src/cli/commit.js";

describe("parseCommitShow", () => {
  it("splits sha / subject / body on the field separator", () => {
    const raw = `abc123${FIELD_SEP}Fix the thing${FIELD_SEP}Body line one\n\nBody line two\n`;
    const c = parseCommitShow(raw);
    expect(c).not.toBeNull();
    expect(c!.sha).toBe("abc123");
    expect(c!.subject).toBe("Fix the thing");
    expect(c!.body).toBe("Body line one\n\nBody line two");
  });

  it("handles a commit with no body (two fields)", () => {
    const raw = `deadbeef${FIELD_SEP}Subject only${FIELD_SEP}\n`;
    const c = parseCommitShow(raw);
    expect(c!.subject).toBe("Subject only");
    expect(c!.body).toBe("");
  });

  it("returns null on empty / shapeless output", () => {
    expect(parseCommitShow("")).toBeNull();
    expect(parseCommitShow("no-separator-here")).toBeNull();
  });

  it("returns null when sha or subject is blank", () => {
    expect(parseCommitShow(`${FIELD_SEP}${FIELD_SEP}body`)).toBeNull();
    expect(parseCommitShow(`sha${FIELD_SEP}${FIELD_SEP}body`)).toBeNull();
  });

  it("preserves a subject that contains spaces and punctuation", () => {
    const raw = `f00${FIELD_SEP}feat(cli): add prune, fix version${FIELD_SEP}`;
    expect(parseCommitShow(raw)!.subject).toBe("feat(cli): add prune, fix version");
  });
});

describe("commitUrlFromRemote", () => {
  it("derives a GitHub commit URL from an SSH remote", () => {
    expect(commitUrlFromRemote("git@github.com:org/repo.git", "abc123")).toBe(
      "https://github.com/org/repo/commit/abc123",
    );
  });

  it("derives a commit URL from an HTTPS remote (with and without .git)", () => {
    expect(commitUrlFromRemote("https://github.com/org/repo.git", "abc123")).toBe(
      "https://github.com/org/repo/commit/abc123",
    );
    expect(commitUrlFromRemote("https://github.com/org/repo", "def456")).toBe(
      "https://github.com/org/repo/commit/def456",
    );
  });

  it("handles nested GitLab group paths", () => {
    expect(commitUrlFromRemote("git@gitlab.com:group/sub/proj.git", "9a9a")).toBe(
      "https://gitlab.com/group/sub/proj/commit/9a9a",
    );
  });

  it("returns null on missing remote or empty sha", () => {
    expect(commitUrlFromRemote(undefined, "abc")).toBeNull();
    expect(commitUrlFromRemote("git@github.com:org/repo.git", "  ")).toBeNull();
  });

  it("returns null on an unparseable / non-http remote", () => {
    expect(commitUrlFromRemote("not a url", "abc")).toBeNull();
    expect(commitUrlFromRemote("ftp://example.com/x", "abc")).toBeNull();
  });
});

describe("commitToDraftFields", () => {
  const commit = {
    sha: "abcdef1234567890",
    subject: "Switch password hashing to Argon2id",
    body: "bcrypt's 72-byte truncation bit us in INC-411.\n\nArgon2id m=64MB.",
  };

  it("maps subject→title, first body paragraph→summary, full message→body", () => {
    const f = commitToDraftFields(commit, null);
    expect(f.title).toBe("Switch password hashing to Argon2id");
    expect(f.summary).toBe("bcrypt's 72-byte truncation bit us in INC-411.");
    expect(f.body).toContain("Switch password hashing to Argon2id");
    expect(f.body).toContain("Argon2id m=64MB.");
    expect(f.body).toContain("Source: commit abcdef123456");
  });

  it("falls back to the subject for summary when there is no body", () => {
    const f = commitToDraftFields({ sha: "f00", subject: "Tidy imports", body: "" }, null);
    expect(f.summary).toBe("Tidy imports");
  });

  it("is low confidence without a source, medium with one", () => {
    expect(commitToDraftFields(commit, null).confidence).toBe("low");
    const sourced = commitToDraftFields(commit, "https://github.com/org/repo/commit/abcdef");
    expect(sourced.confidence).toBe("medium");
    expect(sourced.source).toBe("https://github.com/org/repo/commit/abcdef");
    expect(sourced.body).toContain("https://github.com/org/repo/commit/abcdef");
  });

  it("caps an over-long subject at the title cap with an ellipsis", () => {
    const longSubject = "x".repeat(250);
    const f = commitToDraftFields({ sha: "f00", subject: longSubject, body: "" }, null);
    expect(f.title.length).toBeLessThanOrEqual(200);
    expect(f.title.endsWith("…")).toBe(true);
  });
});
