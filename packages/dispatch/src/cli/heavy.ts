// Everything a CLI command's action needs that `--version`, `--help` and
// `help <command>` must not load: the database layer, the services and zod (with
// the zod 3 error map, installed on import). runtime.ts imports this module once,
// from the program's preAction hook, so it loads only when an action is about to
// run. Command modules reach it through runtime.ts.
import "../util/zod3Compat.js";

export { z } from "zod";

export { Dispatch } from "../core.js";
export { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
export { GIT_REF_SAFE } from "../domain/schemas.js";
export { readJudgeAgreement, renderJudgeAgreement } from "../health/judgeAgreement.js";
export {
  EXCLUDED_TABLES,
  exportState,
  importStateFromJson,
  serializeBundle,
  verifyBundleRestores,
} from "../io/stateExport.js";
export { buildNotifierFromEnv } from "../notify/config.js";
export { computeStats, renderDoctor, renderHumanQueue, renderStats, runDoctor } from "./ops.js";
export { open } from "./shared.js";
