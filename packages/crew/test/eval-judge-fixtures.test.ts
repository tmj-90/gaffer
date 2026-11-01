/**
 * EVAL JUDGE FIXTURE RUN: the plumbing from a known-quality delivery to the agreement
 * report, end to end, with no model.
 *
 * The deliveries are the gate-replay fixtures (runner/eval/fixtures) that carry a `judge`
 * block: one good (clean-feature), three that every gate passes but a careful reviewer
 * rejects (duplicated-helper, weakened-assertion, trivial-replacement), and one the gates
 * bounce (breaks-tests), which the runner never judges. For each judged one this test
 * does what runner/lib/eval-judge.sh and the reviewer do:
 *
 *   real git repo (base + the delivery committed on its branch) -> real Dispatch ticket
 *   submitted to review -> the runner's diff (git diff base..branch) -> the REAL judge
 *   prompt -> a DETERMINISTIC stub judge that returns the fixture's recorded rubric ->
 *   the REAL verdict parse and aggregation -> recorded on the ticket (system) and in the
 *   ledger -> the human outcome the fixture names (approve / reject with a reason) ->
 *   `readJudgeAgreement` pairs them.
 *
 * What it proves: every step between a judge reply and the agreement report is wired and
 * reads the right delivery. What it cannot prove: that a real judge model scores these
 * deliveries the way the recorded rubric does. That is measured on a factory with
 * `gaffer eval agreement` (docs/eval-harness.md, "Is the judge worth having?").
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatch, readJudgeAgreement } from "dispatch";

import { parseJudgeVerdict, renderJudgePrompt } from "../src/eval/deliveryJudge.js";
import { formatRecord, parseLedger, summarize } from "../src/eval/evalLedger.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../runner/eval/fixtures");

interface JudgeBlock {
  quality: "good" | "poor";
  defect?: string;
  judged?: false;
  review?: { outcome: "approve" | "reject"; reason?: string };
  reply?: { dimensions: unknown[]; summary: string };
}
interface Fixture {
  name: string;
  title: string;
  base: string;
  delivery?: string;
  acceptance?: Array<{ text: string; check?: string }>;
  expected: { outcome: string };
  judge: JudgeBlock;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((d) => !d.startsWith("_") && existsSync(join(FIXTURES, d, "fixture.json")))
    .map((d) => ({
      name: d,
      ...(JSON.parse(readFileSync(join(FIXTURES, d, "fixture.json"), "utf8")) as Omit<
        Fixture,
        "name"
      >),
    }))
    .filter((f) => f.judge !== undefined);
}

/**
 * The stand-in for the judge model: deterministic, and it never looks at the quality
 * label. It finds the ticket the prompt names and replies with that fixture's recorded
 * rubric, fenced like a model reply. A prompt that does not carry the delivery's own diff
 * inside the quarantine envelope gets no grading, so a miswired input fails the run.
 */
function stubJudge(prompt: string, fixtures: Fixture[], diffs: Map<string, string>): string {
  const title = /^Ticket: (.*)$/m.exec(prompt)?.[1] ?? "";
  const fx = fixtures.find((f) => f.title === title);
  if (!fx?.judge.reply) return "I cannot grade this.";
  const env = /<untrusted-delivery-diff>\n([\s\S]*?)\n<\/untrusted-delivery-diff>/.exec(prompt);
  if (!env || env[1] !== diffs.get(fx.name)) return "I cannot grade this.";
  return `\`\`\`json\n${JSON.stringify(fx.judge.reply)}\n\`\`\``;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("eval judge fixture run: known-quality deliveries through the judge's plumbing", () => {
  const human = { type: "human", id: "reviewer" } as const;
  const agent = { type: "agent", id: "agent-runner" } as const;
  const system = { type: "system" } as const;
  let tmp: string;
  let wg: Dispatch;
  const fixtures = loadFixtures();
  const diffs = new Map<string, string>();
  const ticketOf = new Map<string, { id: string; number: number }>();
  const ledger: string[] = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-judge-fx-"));
    wg = Dispatch.open(":memory:", undefined, undefined, { testingEnabled: false });
  });
  afterAll(() => {
    wg?.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("covers a good delivery, the three gate-passing poor ones, and a gate-bounced one", () => {
    const by = Object.fromEntries(fixtures.map((f) => [f.name, f.judge.quality]));
    expect(by).toMatchObject({
      "clean-feature": "good",
      "duplicated-helper": "poor",
      "weakened-assertion": "poor",
      "trivial-replacement": "poor",
      "breaks-tests": "poor",
    });
    // The judge only ever sees submitted work: a fixture the gates bounce is never judged,
    // and every judged one is one the gates submit (the replay pins both).
    for (const f of fixtures) {
      if (f.judge.judged === false) expect(f.expected.outcome).toMatch(/^rework:/);
      else expect(f.expected.outcome).toBe("submit");
    }
  });

  it("judges each submitted delivery and records the verdict on its ticket", () => {
    const reg = wg.registerAgent({ display_name: "fixture-agent" }, human);
    for (const f of fixtures.filter((x) => x.judge.judged !== false)) {
      // The delivery as the runner leaves it: base on main, the patch on its branch.
      const repo = join(tmp, f.name);
      cpSync(join(FIXTURES, f.base), repo, { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "base");
      const branch = `gaffer/${f.name}`;
      git(repo, "checkout", "-qb", branch);
      git(repo, "apply", join(FIXTURES, f.name, f.delivery ?? "delivery.patch"));
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "deliver");
      git(repo, "checkout", "-q", "main");

      const r = wg.registerRepository(
        { name: f.name, default_branch: "main", local_path: repo },
        human,
      );
      const t = wg.createTicket(
        { title: f.title, policy_pack: "solo_loose", risk_level: "low" },
        human,
      );
      for (const ac of f.acceptance ?? [])
        wg.addAcceptanceCriterion({ ticket_id: t.id, text: ac.text }, human);
      wg.setTicketRepoAccess(
        { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
        human,
      );
      wg.markReady(t.id, human);
      const claim = wg.claimTicket({ ticket_id: t.id, agent_id: reg.id, ttl_seconds: 300 }, agent);
      wg.recordRepoDelivery({ ticket_id: t.id, repo_id: r.id, branch_name: branch }, human);
      wg.recordDeliveryArtifact(
        { claim_token: claim.claimToken, ticket_id: t.id, branch_name: branch },
        agent,
      );
      wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id }, agent);
      expect(wg.view(t.id).ticket.status).toBe("in_review");
      ticketOf.set(f.name, { id: t.id, number: t.number! });

      // What eval-judge.sh does: the diff base..branch, the ticket's title and criteria.
      const diff = git(repo, "diff", `main..${branch}`);
      diffs.set(f.name, diff);
      const view = wg.view(t.id);
      const prompt = renderJudgePrompt({
        ticketTitle: view.ticket.title,
        acceptanceCriteria: view.acceptanceCriteria.map((a, i) => ({
          id: `AC${i + 1}`,
          text: a.text,
        })),
        diff,
      });
      expect(prompt).toContain(`Ticket: ${f.title}`);
      const verdict = parseJudgeVerdict(stubJudge(prompt, fixtures, diffs));
      expect(verdict.judged).toBe(true);
      // json-tool judge-record's shape: the verdict plus the delivery's context.
      const record = { ...verdict, ticketId: String(t.number), repo: f.name, memoryPresent: false };
      // evalLedgerCli's record (the ledger copy the runner appends beside the event).
      ledger.push(
        formatRecord({
          ts: new Date().toISOString(),
          ticketId: String(t.number),
          repo: f.name,
          overall: verdict.overall,
          score: verdict.score,
          blocking: verdict.blocking,
          memoryPresent: false,
          dims: Object.fromEntries(verdict.dimensions.map((d) => [d.dimension, d.score])),
        }),
      );
      wg.recordEvalJudgment(t.id, record, system);
    }
    expect(ticketOf.size).toBe(4);
  });

  it("aggregates the recorded rubrics: a copied helper is only borderline, a regression fails", () => {
    const v = (name: string) => wg.view(ticketOf.get(name)!.id).evalJudgment!;
    expect(v("clean-feature")).toMatchObject({ overall: "pass", score: 4.8 });
    // Minimalism is not a hard gate in the aggregation: a delivery whose only fault is a
    // duplicated helper reads borderline, not fail. The warning a reviewer can act on is
    // therefore "not pass", which is what the agreement report counts.
    expect(v("duplicated-helper")).toMatchObject({
      overall: "borderline",
      dims: { minimalism: 2 },
    });
    expect(v("weakened-assertion")).toMatchObject({ overall: "fail", blocking: true });
    expect(v("trivial-replacement")).toMatchObject({ overall: "fail", dims: { test_adequacy: 0 } });
    // The reviewer sees the grade and its reasons in the review packet.
    const packet = wg.reviewPacket(ticketOf.get("weakened-assertion")!.id, () => ({
      cost_usd: 0,
      measured_usd: 0,
      estimated_usd: 0,
      num_turns: 0,
      unknown_calls: 0,
      ledger_status: "ok",
    }));
    expect(packet.judge?.rationale.test_adequacy).toMatch(/assert\.ok\(task\)/);
    // The ledger summary sees the same four verdicts.
    const s = summarize(parseLedger(ledger.join("\n")));
    expect(s.count).toBe(4);
    expect(s.passRate).toBe(0.25);
  });

  it("pairs every judgment with the reviewer's decision and reports the agreement", () => {
    for (const f of fixtures.filter((x) => x.judge.judged !== false)) {
      const t = ticketOf.get(f.name)!;
      if (f.judge.review?.outcome === "approve") {
        expect(wg.approveReview(t.id, human).ticket.status).toBe("ready_for_merge");
      } else {
        wg.rejectReview(t.id, "refining", human, f.judge.review?.reason);
      }
    }
    const r = readJudgeAgreement(wg.db, { ledgerJsonl: ledger.join("\n") });
    expect(r.judgments).toBe(4);
    // The ledger copies are the same judgments as the ticket events: counted once.
    expect(r.fromEvents).toBe(4);
    expect(r.fromLedger).toBe(0);
    expect(r.decided).toBe(4);
    expect(r.coverage).toEqual({ reviewEntries: 4, judged: 4, rate: 1 });
    expect(r.table).toEqual({
      pass: { accepted: 1, rejected: 0, pending: 0 },
      borderline: { accepted: 0, rejected: 1, pending: 0 },
      fail: { accepted: 0, rejected: 2, pending: 0 },
    });
    expect(r.warning).toMatchObject({ precision: 1, recall: 1 });
    expect(r.auc).toBe(1);
    expect(r.misses).toEqual([]);
    expect(r.falseAlarms).toEqual([]);
    expect(r.byDecider.human).toEqual({ accepted: 1, rejected: 3 });
    const why = r.pairs.find((p) => p.ticketNumber === ticketOf.get("duplicated-helper")!.number);
    expect(why?.reason).toMatch(/duplicates addTask/);
    // Four deliveries are a plumbing check, never a verdict on the judge.
    expect(r.reading.status).toBe("insufficient_data");
  });
});
