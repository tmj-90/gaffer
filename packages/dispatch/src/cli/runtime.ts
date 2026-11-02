/**
 * Lazy loading for the CLI (`wg` is spawned dozens of times per runner tick).
 *
 * Building the command tree (every name, option, description and help group) needs
 * only commander and the light modules, so `--version`, `--help` and
 * `help <command>` stop there. What an action needs sits behind a feature here:
 * "core" (heavy.ts: the database, the services, zod) for every action, loaded by
 * the program's root preAction hook, and a few larger modules only one command
 * uses, loaded by that command's own preAction hook ({@link needs}). Commander
 * awaits a hook before the action runs, so an action reaches its modules
 * synchronously through {@link lazy} or the deferred functions below. A command
 * module never imports them statically.
 *
 * The MCP server and the REST server import the domain modules themselves, once,
 * and do not use this module.
 */
const loaders = {
  core: () => import("./heavy.js"),
  /** `decisions resolve`: the REST body schema it validates with. */
  decisionSchemas: () => import("../api/schemas.js"),
} as const;

export type CliFeature = keyof typeof loaders;
export type CliModule<F extends CliFeature> = Awaited<ReturnType<(typeof loaders)[F]>>;

const loaded: { [F in CliFeature]?: CliModule<F> } = {};

/** Load these features (default: all of them), once each. */
export async function loadCliModules(
  features: readonly CliFeature[] = Object.keys(loaders) as CliFeature[],
): Promise<void> {
  for (const f of features) {
    if (loaded[f] === undefined) Object.assign(loaded, { [f]: await loaders[f]() });
  }
}

/**
 * A preAction hook that loads `features` first. Once they are loaded it returns
 * nothing, so commander stays synchronous (a test that loaded everything up front
 * can still call `program.parse()`).
 */
export function needs(...features: CliFeature[]): () => Promise<void> | undefined {
  return () => (features.every((f) => loaded[f]) ? undefined : loadCliModules(features));
}

/**
 * A loaded feature, for code inside an action. A program from buildProgram() loads
 * "core" before any action, and a command that needs more says so with
 * {@link needs}; a test driving the register functions on its own Command awaits
 * loadCliModules() first.
 */
export function lazy<F extends CliFeature>(feature: F): CliModule<F> {
  const mod = loaded[feature];
  if (mod === undefined) {
    throw new Error(`internal: a CLI action ran before its "${feature}" modules were loaded`);
  }
  return mod as CliModule<F>;
}

/** The "core" feature (heavy.ts). */
export function heavy(): CliModule<"core"> {
  return lazy("core");
}

type CoreFn = {
  [K in keyof CliModule<"core">]: CliModule<"core">[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof CliModule<"core">];

/** A function of heavy.ts, callable from an action without a static import. */
function deferred<K extends CoreFn>(name: K): CliModule<"core">[K] {
  return ((...args: unknown[]) =>
    (heavy()[name] as (...a: unknown[]) => unknown)(...args)) as CliModule<"core">[K];
}

export const open = deferred("open");
export const buildNotifierFromEnv = deferred("buildNotifierFromEnv");
export const readJudgeAgreement = deferred("readJudgeAgreement");
export const renderJudgeAgreement = deferred("renderJudgeAgreement");
export const computeStats = deferred("computeStats");
export const renderDoctor = deferred("renderDoctor");
export const renderHumanQueue = deferred("renderHumanQueue");
export const renderStats = deferred("renderStats");
export const runDoctor = deferred("runDoctor");
export const exportState = deferred("exportState");
export const importStateFromJson = deferred("importStateFromJson");
export const serializeBundle = deferred("serializeBundle");
export const verifyBundleRestores = deferred("verifyBundleRestores");
