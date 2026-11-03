import { z } from "zod";

/**
 * ACCEPTANCE PROFILES (Release C, C0): how the independent tester's PASS is proven for a
 * ticket. `unit` is today's behaviour (the tester's tests, replayed on a clean checkout).
 * `cli` and `api` add runner-run evidence: the runner itself runs the commands a PERSON
 * registered and records what happened (a transcript, the probe responses). `web`,
 * `migration` and `performance` have their fields defined but are not executable yet:
 * the runner cannot produce their evidence, so only a person's verdict can pass them.
 *
 * The profile and its spec live in the ticket's test_contract JSON (`profile`,
 * `profile_spec`), so they are part of the contract hash the verdict is bound to and are
 * frozen from in_testing on, like the rest of the contract. They are not in the dossier
 * subject (the dossier hash never covered the test contract).
 */
export {
  ACCEPTANCE_PROFILES,
  contractProfile,
  EXECUTABLE_PROFILES,
  isAcceptanceProfile,
  type AcceptanceProfile,
} from "./acceptanceProfileNames.js";
import { type AcceptanceProfile } from "./acceptanceProfileNames.js";

const argv = z.array(z.string().min(1).max(2_000)).min(1).max(64);
const envMap = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "an environment variable name"),
    z.string().max(2_000),
  )
  .refine((m) => Object.keys(m).length <= 32, "at most 32 environment variables");
const patterns = z.array(z.string().min(1).max(500)).max(20);
// A path inside the checkout: relative, no `..` segment, no NUL.
const relPath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !p.startsWith("/") && !p.includes("\0") && !p.split(/[\\/]/).some((s) => s === ".."),
    "a path relative to the checkout, without '..'",
  );
const timeoutMs = z.number().int().min(100).max(300_000);

export const cliCaseSpec = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  argv,
  stdin: z.string().max(16_000).optional(),
  env: envMap.optional(),
  timeout_ms: timeoutMs.optional(),
  expect: z
    .object({
      exit: z.number().int().min(0).max(255).default(0),
      stdout: patterns.optional(),
      stderr: patterns.optional(),
      stdout_absent: patterns.optional(),
      files: z
        .array(
          z.object({
            path: relPath,
            exists: z.boolean().default(true),
            contains: z.string().min(1).max(500).optional(),
          }),
        )
        .max(20)
        .optional(),
    })
    .default({ exit: 0 }),
});

export const cliProfileSpec = z.object({
  cases: z.array(cliCaseSpec).min(1).max(20),
});

const httpMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const urlPath = z
  .string()
  .min(1)
  .max(2_000)
  .refine((p) => p.startsWith("/") && !p.startsWith("//"), "a path that starts with one '/'");

export const apiProbeSpec = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  method: httpMethod.default("GET"),
  path: urlPath,
  headers: z
    .record(z.string().min(1).max(100), z.string().max(2_000))
    .refine((m) => Object.keys(m).length <= 20, "at most 20 headers")
    .optional(),
  body: z.union([z.string().max(16_000), z.record(z.string(), z.unknown())]).optional(),
  expect: z.object({
    status: z.number().int().min(100).max(599),
    body_contains: patterns.optional(),
    json_keys: z.array(z.string().min(1).max(200)).max(50).optional(),
    /** A JSON pointer into the declared schema file (e.g. "#/components/schemas/User"). */
    schema_ref: z.string().min(1).max(500).optional(),
  }),
});

export const apiProfileSpec = z.object({
  boot_argv: argv,
  /** The environment variable the runner sets to the free port it picked. */
  port_env: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .default("PORT"),
  health_path: urlPath,
  boot_timeout_ms: timeoutMs.optional(),
  env: envMap.optional(),
  /** An OpenAPI / JSON schema file in the repository the probes' schema_ref points into. */
  schema_path: relPath.optional(),
  probes: z.array(apiProbeSpec).min(1).max(30),
});

// Defined, not executable yet: a spec is accepted so a person can record intent, and the
// tester's PASS on such a ticket is held for a person's verdict.
export const webProfileSpec = z.object({
  boot_argv: argv.optional(),
  base_path: urlPath.optional(),
  flows: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        steps: z.array(z.string().min(1).max(500)).max(50),
      }),
    )
    .max(20)
    .optional(),
});
export const migrationProfileSpec = z.object({
  seed_argv: argv.optional(),
  up_argv: argv.optional(),
  down_argv: argv.optional(),
  tables: z.array(z.string().min(1).max(200)).max(50).optional(),
});
export const performanceProfileSpec = z.object({
  bench_argv: argv.optional(),
  rounds: z.number().int().min(1).max(50).optional(),
  threshold: z.string().max(200).optional(),
});

export const PROFILE_SPEC_SCHEMAS = {
  cli: cliProfileSpec,
  api: apiProfileSpec,
  web: webProfileSpec,
  migration: migrationProfileSpec,
  performance: performanceProfileSpec,
} as const;

export type CliProfileSpec = z.infer<typeof cliProfileSpec>;
export type ApiProfileSpec = z.infer<typeof apiProfileSpec>;

/**
 * Validate a person's profile + spec. `unit` takes no spec. A runnable profile (cli, api)
 * without a spec is allowed (it states intent; the tester's PASS then holds until the
 * cases are registered). Returns the normalised spec (defaults applied) or null.
 */
export function parseProfileSpec(
  profile: AcceptanceProfile,
  spec: unknown,
): Record<string, unknown> | null {
  if (profile === "unit") return null;
  if (spec === undefined || spec === null) return null;
  return PROFILE_SPEC_SCHEMAS[profile].parse(spec) as Record<string, unknown>;
}

/**
 * The profile a ticket's title suggests, for the seeded contract (a deterministic text
 * derivation, recorded as `profile_seeded_from: "title"`): a title naming a CLI or a
 * command-line verb -> cli; one naming an endpoint, a REST or HTTP API -> api. Only the
 * runnable profiles are suggested, and never a spec: the commands are a person's to
 * register. Off when GAFFER_ACCEPTANCE_PROFILE_SEED is 0.
 */
export function profileFromTitle(
  title: string,
  env: NodeJS.ProcessEnv = process.env,
): AcceptanceProfile | null {
  const seed =
    env === process.env
      ? process.env.GAFFER_ACCEPTANCE_PROFILE_SEED
      : env.GAFFER_ACCEPTANCE_PROFILE_SEED;
  if (/^(0|false|no|off)$/i.test(String(seed ?? "").trim())) return null;
  const t = String(title ?? "");
  if (/\b(cli|command[- ]line|sub-?commands?)\b/i.test(t)) return "cli";
  if (/\b(endpoints?|rest(ful)? api|http api|api routes?|api endpoints?)\b/i.test(t)) return "api";
  return null;
}

/** The reserved uri prefix of a runner-recorded acceptance evidence row. */
export const ACCEPTANCE_EVIDENCE_PREFIX = "gaffer-acceptance:";
/** The cap on one acceptance evidence payload (the runner bounds each excerpt well below). */
export const ACCEPTANCE_EVIDENCE_PAYLOAD_MAX = 64 * 1024;

const sha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i);
/** The runner's acceptance evidence payload, as dispatch accepts it (shape, not content). */
export const acceptanceEvidencePayload = z.object({
  kind: z.enum(["transcript", "api_response"]),
  profile: z.enum(["cli", "api"]),
  tested_commit: sha,
  contract_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  passed: z.boolean(),
  reason: z.string().max(2_000).optional(),
  digest: z.string().regex(/^[0-9a-f]{64}$/i),
  signature: z.string().max(200).optional(),
  sandbox: z.string().max(200).optional(),
  cases: z.array(z.record(z.string(), z.unknown())).max(50),
  /** api: the boot command, port, health wait and the service's own output excerpts. */
  boot: z.record(z.string(), z.unknown()).optional(),
});
export type AcceptanceEvidencePayload = z.infer<typeof acceptanceEvidencePayload>;
