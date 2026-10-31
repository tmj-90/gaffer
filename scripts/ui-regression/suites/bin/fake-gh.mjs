#!/usr/bin/env node
// A recording stand-in for the GitHub CLI (`gh`), for the own-server scenario suites
// (own-env.sh's fake-gh fixture installs it first on PATH). It answers only the
// subcommands the factory runs, with the REAL CLI's field rules: a `--json` field the
// real gh (2.89.0, `gh <cmd> --help` → JSON FIELDS) does not list is refused exactly as
// gh refuses it (`Unknown JSON field: "<name>"`, exit 1), so an adapter asking for a
// field GitHub does not have fails here as it would live.
//
//   node fake-gh.mjs <state-dir> <gh argv…>
//
// State (all under <state-dir>, read and written by the suites too):
//   calls.jsonl   one line per call: {ts, argv, cwd, cmd, fields, unknown, exit}
//   prs.json      {next, prs:[{number,url,head,base,title,state,mergedAt,mergeCommit}]}
//   ci-state      pending | pass | fail (default pass): every PR's checks
//   issues.json   [{number,title,body,url,state,labels:[{name}]}] for `issue list`
//
//   pr create --title T --body-file F --base B --head H   → prints the new PR's URL
//   pr view <branch|url|number> --json F [--jq E]        → the PR, real fields only
//   pr checks <branch|url|number> --json F [--jq E]      → two checks (lint, test)
//   pr merge <url> --merge|--squash|--rebase [--delete-branch] [--match-head-commit S]
//       → merges the head into the base IN the origin remote (a local bare repo)
//   run list --json F [--branch B] [--commit S] [-L N]  → one CI run per PR head
//   issue list --repo S --label L --state open --json F  → the labelled open issues
//   issue edit N --repo S --add-label A --remove-label R  → relabels
// Anything else exits 1 ("unknown command"), recorded like every other call.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const [STATE, ...argv] = process.argv.slice(2);
const cwd = process.cwd();
const SLUG = "acme/taskflow-mini";

// The JSON FIELDS of the real `gh` 2.89.0 (its --help), per subcommand.
const FIELDS = {
  "pr checks": "bucket completedAt description event link name startedAt state workflow".split(" "),
  "pr view": (
    "additions assignees author autoMergeRequest baseRefName baseRefOid body changedFiles " +
    "closed closedAt closingIssuesReferences comments commits createdAt deletions files " +
    "fullDatabaseId headRefName headRefOid headRepository headRepositoryOwner id " +
    "isCrossRepository isDraft labels latestReviews maintainerCanModify mergeCommit " +
    "mergeStateStatus mergeable mergedAt mergedBy milestone number potentialMergeCommit " +
    "projectCards projectItems reactionGroups reviewDecision reviewRequests reviews state " +
    "statusCheckRollup title updatedAt url"
  ).split(" "),
  "run list": (
    "attempt conclusion createdAt databaseId displayTitle event headBranch headSha name " +
    "number startedAt status updatedAt url workflowDatabaseId workflowName"
  ).split(" "),
  "issue list": (
    "assignees author body closed closedAt closedByPullRequestsReferences comments " +
    "createdAt id isPinned labels milestone number projectCards projectItems " +
    "reactionGroups state stateReason title updatedAt url"
  ).split(" "),
};

const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
const cmd = argv.slice(0, 2).join(" ");
const fields = (opt("--json") || "").split(",").filter(Boolean);
const record = {
  ts: new Date().toISOString(),
  argv,
  cwd,
  cmd,
  fields,
  unknown: [],
  exit: 0,
};
const rd = (f, dflt) => {
  try {
    return JSON.parse(readFileSync(path.join(STATE, f), "utf8"));
  } catch {
    return dflt;
  }
};
const wr = (f, v) => writeFileSync(path.join(STATE, f), JSON.stringify(v, null, 2));
const done = (code, out = "", err = "") => {
  record.exit = code;
  try {
    appendFileSync(path.join(STATE, "calls.jsonl"), JSON.stringify(record) + "\n");
  } catch {
    /* recording is best-effort */
  }
  if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  if (err) process.stderr.write(err.endsWith("\n") ? err : err + "\n");
  process.exit(code);
};
const git = (dir, ...a) =>
  execFileSync("git", ["-c", "user.email=gh@fake", "-c", "user.name=fake-gh", ...a], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
const tryGit = (dir, ...a) => {
  try {
    return git(dir, ...a);
  } catch {
    return "";
  }
};
/** The origin remote's path (a local bare repo in the suites), else "". */
const originDir = () => {
  const u = tryGit(cwd, "remote", "get-url", "origin");
  return u && !/^[a-z]+:\/\//i.test(u) && existsSync(u) ? u : "";
};
const headSha = (branch) => {
  const o = originDir();
  return (
    (o && tryGit(o, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) ||
    tryGit(cwd, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)
  );
};

/** Refuse unknown fields as the real CLI does; answer only the requested ones. */
function exportJson(kind, value) {
  const allowed = FIELDS[kind];
  record.unknown = fields.filter((f) => !allowed.includes(f));
  if (record.unknown.length)
    done(
      1,
      "",
      `Unknown JSON field: "${record.unknown[0]}"\nAvailable fields:\n` +
        allowed.map((f) => `  ${f}`).join("\n"),
    );
  const pick = (o) => Object.fromEntries(fields.map((f) => [f, o[f] ?? null]));
  const out = Array.isArray(value) ? value.map(pick) : pick(value);
  const jq = opt("--jq") ?? opt("-q");
  if (jq) {
    try {
      return done(
        0,
        execFileSync("jq", ["-r", jq], { input: JSON.stringify(out) })
          .toString()
          .trimEnd(),
      );
    } catch (e) {
      return done(1, "", `jq: ${e.message}`);
    }
  }
  return done(0, JSON.stringify(out));
}

const prs = rd("prs.json", { next: 1, prs: [] });
/** By number, URL or head branch (a branch's OPEN PR first, as the real CLI picks). */
const findPr = (sel) =>
  prs.prs.find((p) => String(p.number) === String(sel) || p.url === sel) ||
  prs.prs.find((p) => p.head === sel && p.state === "OPEN") ||
  [...prs.prs].reverse().find((p) => p.head === sel);
const ciState = () => {
  try {
    return readFileSync(path.join(STATE, "ci-state"), "utf8").trim() || "pass";
  } catch {
    return "pass";
  }
};

function checksFor(pr) {
  const s = ciState();
  const at = new Date().toISOString();
  const one = (name, red) => ({
    bucket: s === "pending" ? "pending" : red ? "fail" : "pass",
    completedAt: s === "pending" ? "0001-01-01T00:00:00Z" : at,
    description: "",
    event: "pull_request",
    link: `https://github.com/${SLUG}/actions/runs/${100 + pr.number}/job/${name === "lint" ? 1 : 2}`,
    name,
    startedAt: at,
    state: s === "pending" ? "IN_PROGRESS" : red ? "FAILURE" : "SUCCESS",
    workflow: "CI",
  });
  return [one("lint", false), one("test", s === "fail")];
}

function main() {
  if (argv[0] === "--version") return done(0, "gh version 2.89.0 (fake)");
  if (cmd === "auth status") return done(0, "Logged in to github.com (fake)");

  if (cmd === "pr create") {
    const head = opt("--head") || tryGit(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    const base = opt("--base") || "main";
    if (!head) return done(1, "", "could not determine the head branch");
    const n = prs.next++;
    const pr = {
      number: n,
      url: `https://github.com/${SLUG}/pull/${n}`,
      head,
      base,
      title: opt("--title") || head,
      state: "OPEN",
      mergedAt: null,
      mergeCommit: null,
      createdAt: new Date().toISOString(),
    };
    prs.prs.push(pr);
    wr("prs.json", prs);
    return done(0, `Creating pull request for ${head} into ${base} in ${SLUG}\n\n${pr.url}`);
  }

  if (cmd === "pr view" || cmd === "pr checks") {
    const sel = argv[2] && !argv[2].startsWith("-") ? argv[2] : "";
    const pr = findPr(sel);
    if (fields.length === 0 && cmd === "pr checks") {
      if (!pr) return done(1, "", `no pull requests found for branch "${sel}"`);
      const rows = checksFor(pr).map((c) => `${c.name}\t${c.bucket}\t0\t${c.link}`);
      return done(ciState() === "pass" ? 0 : ciState() === "pending" ? 8 : 1, rows.join("\n"));
    }
    if (fields.length === 0) return done(1, "", "fake gh: pr view needs --json");
    // Field validation happens before the lookup, as in the real CLI.
    const kind = cmd;
    const bad = fields.filter((f) => !FIELDS[kind].includes(f));
    if (bad.length) return exportJson(kind, {});
    if (!pr) return done(1, "", `no pull requests found for branch "${sel}"`);
    if (cmd === "pr checks") return exportJson(kind, checksFor(pr));
    const sha = headSha(pr.head);
    return exportJson(kind, {
      ...pr,
      headRefName: pr.head,
      baseRefName: pr.base,
      headRefOid: sha,
      closed: pr.state !== "OPEN",
      isDraft: false,
      mergeable: pr.state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
      mergeStateStatus:
        pr.state === "OPEN" ? (ciState() === "pass" ? "CLEAN" : "BLOCKED") : "UNKNOWN",
      mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
      statusCheckRollup: checksFor(pr).map((c) => ({
        __typename: "CheckRun",
        name: c.name,
        status: c.bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: c.bucket === "pending" ? "" : c.state,
        detailsUrl: c.link,
      })),
    });
  }

  if (cmd === "pr merge") {
    const pr = findPr(argv[2]);
    if (!pr) return done(1, "", `could not find pull request ${argv[2]}`);
    if (pr.state !== "OPEN") return done(1, "", `Pull request #${pr.number} is not open`);
    const origin = originDir();
    if (!origin) return done(1, "", "fake gh: the origin remote is not a local bare repo");
    const sha = headSha(pr.head);
    const pin = opt("--match-head-commit");
    if (pin && pin !== sha)
      return done(1, "", `Head branch was modified. Review and try the merge again.`);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "fake-gh-merge-"));
    try {
      git(tmp, "clone", "-q", origin, ".");
      git(tmp, "checkout", "-q", pr.base);
      const msg = `Merge pull request #${pr.number} from ${pr.head}`;
      if (has("--squash")) {
        git(tmp, "merge", "--squash", `origin/${pr.head}`);
        git(tmp, "commit", "-qm", `${pr.title} (#${pr.number})`);
      } else if (has("--rebase")) {
        git(tmp, "rebase", "-q", `origin/${pr.head}`);
      } else git(tmp, "merge", "--no-ff", "-m", msg, `origin/${pr.head}`);
      git(tmp, "push", "-q", "origin", pr.base);
      if (has("--delete-branch")) tryGit(tmp, "push", "-q", "origin", "--delete", pr.head);
      pr.state = "MERGED";
      pr.mergedAt = new Date().toISOString();
      pr.mergeCommit = git(tmp, "rev-parse", "HEAD");
      wr("prs.json", prs);
    } catch (e) {
      return done(
        1,
        "",
        `Pull request #${pr.number} is not mergeable: ${String(e.message).split("\n")[0]}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return done(0, `✓ Merged pull request #${pr.number} (${pr.title})`);
  }

  if (cmd === "run list") {
    if (fields.length === 0) return done(1, "", "fake gh: run list needs --json");
    const branch = opt("--branch") || opt("-b");
    const commit = opt("--commit") || opt("-c");
    const s = ciState();
    const runs = prs.prs
      .filter((p) => !branch || p.head === branch)
      .map((p) => {
        const sha = headSha(p.head);
        return {
          attempt: 1,
          conclusion: s === "pending" ? "" : s === "fail" ? "failure" : "success",
          createdAt: p.createdAt,
          databaseId: 100 + p.number,
          displayTitle: p.title,
          event: "pull_request",
          headBranch: p.head,
          headSha: sha,
          name: "CI",
          number: p.number,
          startedAt: p.createdAt,
          status: s === "pending" ? "in_progress" : "completed",
          updatedAt: new Date().toISOString(),
          url: `https://github.com/${SLUG}/actions/runs/${100 + p.number}`,
          workflowDatabaseId: 7,
          workflowName: "CI",
        };
      })
      .filter((r) => !commit || r.headSha === commit);
    return exportJson("run list", runs);
  }

  if (cmd === "issue list") {
    if (fields.length === 0) return done(1, "", "fake gh: issue list needs --json");
    const label = opt("--label") || opt("-l");
    const state = (opt("--state") || opt("-s") || "open").toUpperCase();
    const issues = rd("issues.json", []).filter(
      (i) =>
        (state === "ALL" || (i.state || "OPEN").toUpperCase() === state) &&
        (!label || (i.labels || []).some((l) => l.name === label)),
    );
    return exportJson(
      "issue list",
      issues.map((i) => ({
        ...i,
        state: (i.state || "OPEN").toUpperCase(),
        labels: (i.labels || []).map((l) => ({
          id: `L_${l.name}`,
          name: l.name,
          description: "",
          color: "ededed",
        })),
      })),
    );
  }

  if (cmd === "issue edit") {
    const all = rd("issues.json", []);
    const issue = all.find((i) => String(i.number) === String(argv[2]));
    if (!issue) return done(1, "", `could not find issue ${argv[2]}`);
    const add = (opt("--add-label") || "").split(",").filter(Boolean);
    const rm = (opt("--remove-label") || "").split(",").filter(Boolean);
    issue.labels = (issue.labels || []).filter((l) => !rm.includes(l.name));
    for (const a of add)
      if (!issue.labels.some((l) => l.name === a)) issue.labels.push({ name: a });
    wr("issues.json", all);
    return done(0, issue.url);
  }

  return done(1, "", `unknown command "${argv.join(" ")}" for "gh" (fake)`);
}

main();
