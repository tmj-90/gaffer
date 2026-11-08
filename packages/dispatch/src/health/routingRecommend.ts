/**
 * ADVISORY ROUTING RECOMMENDATIONS (delta roadmap gap 4, P3). Reads the routing scorecard
 * (routingScorecard.ts) and any matched experiment results (runner/eval/experiment.sh) and,
 * where the evidence is strong enough, PRINTS a proposed model-registry.json change as a
 * unified diff with the cells, n and deltas behind it. It never writes the registry, never
 * changes how route-model.mjs routes, and never proposes anything for a safety lane: a
 * person applies a proposal by editing the registry (or pointing GAFFER_MODEL_REGISTRY at an
 * edited copy). Pure apart from the readers at the bottom.
 *
 * The rule (fixed, so a proposal can be checked by hand):
 *   - only the implement role is proposed for: it is the role the scorecard measures
 *     outcomes for. The review phase default also routes the security second opinion, a
 *     safety lane, and the tester is a safety lane, so neither is ever proposed.
 *   - scorecard: compare the implement default tier's model with each other tier's model in
 *     every work class (provider, risk, stack) where BOTH cells have at least the minimum n
 *     and a first-pass and cost-per-accepted-change figure. Propose a tier when it is cheaper
 *     per accepted change and no worse on first-pass acceptance and escaped defects in every
 *     such class ("cheaper, no worse"), or when it is at least 10 points better on first-pass
 *     acceptance in every such class ("better, costs more": a trade-off a person weighs).
 *   - experiment: a live matched experiment whose arm differs from its baseline only in the
 *     implement tier, whose baseline ran the default implement tier, over at least the
 *     minimum number of tickets, with at least one discordant ticket (one arm accepted, the
 *     other not), whose paired difference in acceptance has a 95% Newcombe paired score
 *     interval with a lower bound at or above minus NON_INFERIORITY_MARGIN, and whose mean
 *     spend difference is below zero. A stub-mode experiment proves the pipeline only and
 *     never proposes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RoutingScorecard, ScorecardCell } from "./routingScorecard.js";

export const PROPOSABLE_ROLE = "implement";
export const BETTER_BY_POINTS = 10;
/**
 * How much worse on acceptance a cheaper tier may be and still be proposed: the lower
 * bound of the 95% interval on (arm acceptance rate minus baseline acceptance rate) must
 * be at or above minus this. 0.10 (ten percentage points) is the usual starting margin
 * for a non-inferiority comparison of proportions, and it matches BETTER_BY_POINTS, the
 * scorecard's own threshold for a difference worth acting on. Requiring the bound at or
 * above zero instead would demand proof that the cheaper tier is BETTER, which a
 * cost-saving switch does not need; a wider margin would accept a real loss of quality.
 */
export const NON_INFERIORITY_MARGIN = 0.1;
/** The acceptance interval method the experiment rule trusts (runner/eval/experiment.mjs). */
export const ACCEPTANCE_INTERVAL_METHOD = "newcombe_paired_score";

export interface Registry {
  readonly tiers: Readonly<Record<string, string>>;
  readonly phaseDefaults: Readonly<Record<string, string>>;
}

export interface ExperimentComparison {
  readonly arm: string;
  readonly vs: string;
  readonly n: number;
  readonly differs_in: readonly string[];
  readonly overrides: Readonly<Record<string, string>>;
  /** The baseline arm's overrides (absent in results written before the field). */
  readonly vs_overrides?: Readonly<Record<string, string>>;
  readonly acceptance: {
    readonly mean: number | null;
    readonly ci95: readonly [number, number] | null;
    /** The interval's method; absent in results written before the paired-proportion interval. */
    readonly method?: string;
    /** Tickets where one arm was accepted and the other not. */
    readonly discordant?: number;
    readonly favours_arm?: number;
    readonly favours_baseline?: number;
  };
  readonly spend_usd: {
    readonly mean: number | null;
    readonly ci95: readonly [number, number] | null;
  };
  readonly attempts: { readonly mean: number | null };
}

export interface ExperimentResults {
  readonly path: string;
  readonly mode: string;
  readonly comparisons: readonly ExperimentComparison[];
}

export interface EvidenceLine {
  readonly work_class: string;
  readonly from: {
    readonly model: string;
    readonly n: number;
    readonly first_pass_pct: number;
    readonly cost_usd: number;
  };
  readonly to: {
    readonly model: string;
    readonly n: number;
    readonly first_pass_pct: number;
    readonly cost_usd: number;
  };
  readonly delta_first_pass_points: number;
  readonly delta_cost_usd: number;
  /** The proposed tier's cell escaped more defects than the default's (both known). */
  readonly escaped_worse: boolean;
}

export interface Proposal {
  readonly role: string;
  readonly from_tier: string;
  readonly to_tier: string;
  readonly basis: "scorecard" | "experiment";
  readonly kind: "cheaper_no_worse" | "better_costs_more" | "experiment";
  readonly evidence: readonly EvidenceLine[];
  readonly experiment: {
    readonly path: string;
    readonly arm: string;
    readonly n: number;
    readonly acceptance: ExperimentComparison["acceptance"];
    readonly spend_usd: ExperimentComparison["spend_usd"];
  } | null;
  readonly diff: string;
}

export interface Recommendation {
  readonly measure: "routing_recommendation";
  readonly advisory: true;
  readonly min_n: number;
  readonly registry_path: string | null;
  readonly proposals: readonly Proposal[];
  readonly not_proposed: readonly string[];
  readonly experiments_read: number;
}

const round = (v: number, p = 2): number => Math.round(v * 10 ** p) / 10 ** p;

/** A one-line unified diff of `text` replacing line `idx` (0-based) with `line`. */
export function unifiedDiff(path: string, text: string, idx: number, line: string): string {
  const lines = text.split("\n");
  const from = Math.max(0, idx - 3);
  const to = Math.min(lines.length, idx + 4);
  const out = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${to - from} +${from + 1},${to - from} @@`,
  ];
  for (let i = from; i < to; i += 1) {
    if (i === idx) {
      out.push(`-${lines[i]}`);
      out.push(`+${line}`);
    } else out.push(` ${lines[i]}`);
  }
  return out.join("\n");
}

/** The line index of `"<phase>": "<tier>"` inside the registry's phaseDefaults block. */
export function phaseDefaultLine(text: string, phase: string): number {
  const lines = text.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] as string;
    if (/^\s*"phaseDefaults"\s*:\s*\{/.test(l)) inBlock = true;
    else if (inBlock && /^\s*\}/.test(l)) return -1;
    else if (inBlock && new RegExp(`^\\s*"${phase}"\\s*:\\s*"[^"]*"`).test(l)) return i;
  }
  return -1;
}

function proposalDiff(
  registryText: string,
  displayPath: string,
  role: string,
  tier: string,
): string {
  const idx = phaseDefaultLine(registryText, role);
  if (idx < 0)
    return `(the registry has no "${role}" line under phaseDefaults: add "${role}": "${tier}" there)`;
  const old = registryText.split("\n")[idx] as string;
  return unifiedDiff(displayPath, registryText, idx, old.replace(/:\s*"[^"]*"/, `: "${tier}"`));
}

const usable = (c: ScorecardCell): boolean =>
  !c.too_few && c.first_pass_pct?.value != null && c.cost_per_accepted_change_usd?.value != null;

/** The recommendation (see the module comment). */
export function recommendRouting(input: {
  scorecard: RoutingScorecard;
  registry: Registry;
  registryText: string;
  registryPath: string | null;
  displayPath?: string;
  experiments?: readonly ExperimentResults[];
}): Recommendation {
  const { scorecard, registry } = input;
  const min = scorecard.min_n;
  const display = input.displayPath ?? "runner/model-registry.json";
  const proposals: Proposal[] = [];
  const notProposed: string[] = [
    "review: its phase default also routes the security second opinion (a safety lane); never proposed",
    "test: the tester is a safety lane; never proposed",
  ];
  const defTier = registry.phaseDefaults[PROPOSABLE_ROLE];
  const defModel = defTier ? registry.tiers[defTier] : undefined;
  if (!defTier || !defModel) {
    notProposed.push(`${PROPOSABLE_ROLE}: the registry names no default tier for it`);
    return {
      measure: "routing_recommendation",
      advisory: true,
      min_n: min,
      registry_path: input.registryPath,
      proposals,
      not_proposed: notProposed,
      experiments_read: input.experiments?.length ?? 0,
    };
  }
  const cells = scorecard.cells.filter((c) => c.role === PROPOSABLE_ROLE);
  const classOf = (c: ScorecardCell) => `provider ${c.provider}, risk ${c.risk}, stack ${c.stack}`;
  for (const [tier, model] of Object.entries(registry.tiers)) {
    if (tier === defTier || model === defModel) continue;
    const evidence: EvidenceLine[] = [];
    for (const to of cells.filter((c) => c.model === model && usable(c))) {
      const from = cells.find(
        (c) =>
          c.model === defModel &&
          c.provider === to.provider &&
          c.risk === to.risk &&
          c.stack === to.stack &&
          usable(c),
      );
      if (!from) continue;
      const fpF = from.first_pass_pct?.value as number;
      const fpT = to.first_pass_pct?.value as number;
      const cF = from.cost_per_accepted_change_usd?.value as number;
      const cT = to.cost_per_accepted_change_usd?.value as number;
      const eF = from.escaped_defect_pct?.value;
      const eT = to.escaped_defect_pct?.value;
      evidence.push({
        work_class: classOf(to),
        from: { model: defModel, n: from.n, first_pass_pct: fpF, cost_usd: cF },
        to: { model, n: to.n, first_pass_pct: fpT, cost_usd: cT },
        delta_first_pass_points: round(fpT - fpF, 1),
        delta_cost_usd: round(cT - cF, 4),
        escaped_worse: eF != null && eT != null && eT > eF,
      });
    }
    if (evidence.length === 0) continue;
    // Never propose a tier that escaped more defects where both are known.
    if (evidence.some((e) => e.escaped_worse)) continue;
    const cheaperNoWorse = evidence.every(
      (e) => e.delta_cost_usd < 0 && e.delta_first_pass_points >= 0,
    );
    const better = evidence.every((e) => e.delta_first_pass_points >= BETTER_BY_POINTS);
    if (!cheaperNoWorse && !better) continue;
    proposals.push({
      role: PROPOSABLE_ROLE,
      from_tier: defTier,
      to_tier: tier,
      basis: "scorecard",
      kind: cheaperNoWorse ? "cheaper_no_worse" : "better_costs_more",
      evidence: evidence.map((e) => ({ ...e })),
      experiment: null,
      diff: proposalDiff(input.registryText, display, PROPOSABLE_ROLE, tier),
    });
  }
  for (const ex of input.experiments ?? []) {
    if (ex.mode !== "live") {
      notProposed.push(
        `experiment ${ex.path}: stub mode proves the pipeline, not a model; never proposes`,
      );
      continue;
    }
    for (const c of ex.comparisons) {
      if (c.differs_in.length !== 1 || c.differs_in[0] !== "tier") continue;
      const tier = c.overrides.tier;
      if (!tier || tier === defTier || !registry.tiers[tier]) continue;
      // The proposal moves the DEFAULT tier, so the baseline must have run the default
      // tier (named, or left to the registry). A baseline on another tier, or results
      // that do not say what the baseline ran, compare two other tiers: never proposed.
      const vsTier: string | null = c.vs_overrides ? (c.vs_overrides.tier ?? defTier) : null;
      if (vsTier !== defTier || c.vs_overrides?.model) {
        notProposed.push(
          `experiment ${ex.path} arm ${c.arm}: its baseline did not run the default ${PROPOSABLE_ROLE} tier ${defTier}`,
        );
        continue;
      }
      const lo = c.acceptance.ci95?.[0];
      const spend = c.spend_usd.mean;
      const why = `experiment ${ex.path} arm ${c.arm}`;
      if (c.n < min) {
        notProposed.push(`${why}: ${c.n} tickets, under the minimum ${min}`);
        continue;
      }
      if (c.acceptance.method !== ACCEPTANCE_INTERVAL_METHOD) {
        notProposed.push(
          `${why}: its acceptance interval is not the paired-proportion interval (results written before it); run its report again`,
        );
        continue;
      }
      if (!c.acceptance.discordant) {
        notProposed.push(
          `${why}: no discordant pairs (both arms had the same outcome on all ${c.n} tickets), so the run says nothing about the difference in acceptance`,
        );
        continue;
      }
      if (lo == null || lo < -NON_INFERIORITY_MARGIN) {
        notProposed.push(
          `${why}: the acceptance difference's 95% interval reaches ${lo ?? "n/a"}, below the non-inferiority margin of -${NON_INFERIORITY_MARGIN}`,
        );
        continue;
      }
      // Spend is continuous (USD), so its mean and paired t interval stay as they are.
      if (spend == null || spend >= 0) {
        notProposed.push(`${why}: not cheaper (mean spend difference ${money(spend)})`);
        continue;
      }
      proposals.push({
        role: PROPOSABLE_ROLE,
        from_tier: defTier,
        to_tier: tier,
        basis: "experiment",
        kind: "experiment",
        evidence: [],
        experiment: {
          path: ex.path,
          arm: c.arm,
          n: c.n,
          acceptance: c.acceptance,
          spend_usd: c.spend_usd,
        },
        diff: proposalDiff(input.registryText, display, PROPOSABLE_ROLE, tier),
      });
    }
  }
  if (proposals.length === 0) {
    const enough = cells.filter((c) => !c.too_few).length;
    notProposed.push(
      enough === 0
        ? `${PROPOSABLE_ROLE}: no cell has ${min} attempts yet (${scorecard.cells.filter((c) => c.role === PROPOSABLE_ROLE).length} cell(s) too few to compare)`
        : `${PROPOSABLE_ROLE}: no other tier is cheaper and no worse, or ${BETTER_BY_POINTS} points better, in every work class with enough attempts on both`,
    );
  }
  return {
    measure: "routing_recommendation",
    advisory: true,
    min_n: min,
    registry_path: input.registryPath,
    proposals,
    not_proposed: notProposed,
    experiments_read: input.experiments?.length ?? 0,
  };
}

const money = (v: number | null | undefined): string => (v == null ? "n/a" : `$${v.toFixed(2)}`);
const ci = (c: readonly [number, number] | null): string => (c ? `[${c[0]}, ${c[1]}]` : "n/a");

/** The text `wg routing recommend` prints. */
export function renderRecommendation(r: Recommendation): string {
  const lines = [
    "Routing recommendations (advisory: nothing was changed; route-model.mjs keeps routing from the registry as it is)",
    `minimum n ${r.min_n} · registry ${r.registry_path ?? "not found"} · ${r.experiments_read} experiment result(s) read`,
    "",
  ];
  if (r.proposals.length === 0) lines.push("No change proposed.");
  r.proposals.forEach((p, i) => {
    const label =
      p.kind === "cheaper_no_worse"
        ? "cheaper per accepted change and no worse on first pass or escaped defects"
        : p.kind === "better_costs_more"
          ? `at least ${BETTER_BY_POINTS} points better on first pass; a trade-off: see the cost deltas`
          : "a live matched experiment";
    lines.push(`${i + 1}. ${p.role}: default tier ${p.from_tier} -> ${p.to_tier} (${label})`);
    lines.push("   Evidence:");
    for (const e of p.evidence)
      lines.push(
        `     ${e.work_class}: ${e.to.model} n=${e.to.n} first pass ${e.to.first_pass_pct}% cost per accepted change ${money(e.to.cost_usd)} | ${e.from.model} n=${e.from.n} first pass ${e.from.first_pass_pct}% cost ${money(e.from.cost_usd)} (delta first pass ${e.delta_first_pass_points} points, cost ${e.delta_cost_usd >= 0 ? "+" : ""}${e.delta_cost_usd})`,
      );
    if (p.experiment)
      lines.push(
        `     experiment ${p.experiment.path}, arm ${p.experiment.arm}: n=${p.experiment.n} tickets, acceptance delta mean ${p.experiment.acceptance.mean} 95% Newcombe paired score interval ${ci(p.experiment.acceptance.ci95)} (${p.experiment.acceptance.discordant ?? 0} discordant pair(s): ${p.experiment.acceptance.favours_arm ?? 0} favour ${p.experiment.arm}, ${p.experiment.acceptance.favours_baseline ?? 0} the baseline; non-inferiority margin ${NON_INFERIORITY_MARGIN}), spend delta mean ${money(p.experiment.spend_usd.mean)} 95% t interval ${ci(p.experiment.spend_usd.ci95)}`,
      );
    lines.push("   Proposed change (apply it yourself by editing the registry):");
    for (const l of p.diff.split("\n")) lines.push(`   ${l}`);
    lines.push("");
  });
  if (r.not_proposed.length) {
    lines.push("Not proposed:");
    for (const n of r.not_proposed) lines.push(`  - ${n}`);
  }
  lines.push(
    "",
    "To apply a proposal: edit runner/model-registry.json (or point GAFFER_MODEL_REGISTRY at an edited copy); the router reads it on the next tick. The scorecard is observational: the router sent different work to each tier, so prefer a matched experiment (gaffer eval experiment) before applying.",
  );
  return lines.join("\n");
}

/** Find the model registry: GAFFER_MODEL_REGISTRY, else runner/model-registry.json above this module. */
export function resolveRegistryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GAFFER_MODEL_REGISTRY)
    return existsSync(env.GAFFER_MODEL_REGISTRY) ? env.GAFFER_MODEL_REGISTRY : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, "runner", "model-registry.json");
    if (existsSync(p)) return p;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Read a registry: its text and the two maps the rule needs, or null. */
export function readRegistry(path: string | null): { text: string; registry: Registry } | null {
  if (!path) return null;
  try {
    const text = readFileSync(path, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    const strMap = (v: unknown): Record<string, string> =>
      Object.fromEntries(
        Object.entries(v && typeof v === "object" ? (v as Record<string, unknown>) : {}).filter(
          (e): e is [string, string] => typeof e[1] === "string" && !e[0].startsWith("$"),
        ),
      );
    return {
      text,
      registry: { tiers: strMap(raw.tiers), phaseDefaults: strMap(raw.phaseDefaults) },
    };
  } catch {
    return null;
  }
}

/** One experiment results.json (runner/eval/experiment.mjs), or null. */
export function readExperimentResults(path: string): ExperimentResults | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.schema !== "gaffer.experiment/1") return null;
    return {
      path,
      mode: typeof raw.mode === "string" ? raw.mode : "stub",
      comparisons: Array.isArray(raw.comparisons)
        ? (raw.comparisons as ExperimentComparison[])
        : [],
    };
  } catch {
    return null;
  }
}

/** The latest experiment results under `<GAFFER_DATA>/experiments/<run>/results.json`. */
export function readExperimentDir(dir: string | null, max = 20): ExperimentResults[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((d) => join(dir, d, "results.json"))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
      .slice(-max)
      .map((p) => readExperimentResults(p))
      .filter((r): r is ExperimentResults => r !== null);
  } catch {
    return [];
  }
}

/** The Health view's one Routing line. */
export function routingHealthLine(r: Recommendation | null): {
  available: boolean;
  proposals: number;
  line: string;
} {
  if (!r || !r.registry_path)
    return {
      available: false,
      proposals: 0,
      line: "Routing: the model registry could not be read",
    };
  if (r.proposals.length === 0)
    return {
      available: true,
      proposals: 0,
      line: "Routing: no registry change proposed. Report only.",
    };
  return {
    available: true,
    proposals: r.proposals.length,
    line: `Routing: ${r.proposals.length} advisory registry change(s) proposed, nothing applied. See gaffer wg routing recommend.`,
  };
}
