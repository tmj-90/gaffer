/**
 * Public library surface. Consumers can:
 *
 *   import { openDb, addLore, suggestLore, searchLore, ... } from "memory-mcp";
 *
 * The MCP server and CLI both live behind separate bin entrypoints
 * (`memory-mcp` and `memory` respectively); this module is for
 * embedding the same logic in another Node process — e.g. an internal
 * service that ingests Slack/Confluence into the same SQLite store.
 */

export { openDb, defaultDbPath } from "./db/index.js";
export {
  addLore,
  approveLore,
  clampConfidence,
  deleteLore,
  deprecateLore,
  getLore,
  getRejectionReason,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  pruneReadEvents,
  rejectLore,
  searchLore,
  searchLoreCount,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "./core/lore.js";
export { newLoreId } from "./core/ids.js";
export {
  addBoundary,
  approveBoundary,
  deprecateBoundary,
  findDependents,
  listBoundaries,
  listBoundaryDrafts,
  normaliseContract,
  rejectBoundary,
  suggestBoundary,
} from "./core/boundaries.js";
export {
  addFeature,
  advanceFeature,
  AdvanceFeatureError,
  getDigest,
  getFeature,
  isLegalFeatureTransition,
  listFeatures,
  upsertDigest,
} from "./core/repoUnderstanding.js";
export type {
  AddFeatureInput,
  AdvanceFeatureRefusal,
  ListFeaturesOptions,
  UpsertDigestInput,
} from "./core/repoUnderstanding.js";
export type {
  AddLoreInput,
  Boundary,
  BoundaryRole,
  BoundaryStatus,
  DigestSource,
  Feature,
  FeatureRow,
  FeatureStatus,
  Lore,
  LoreConfidence,
  LoreRow,
  LoreStatus,
  LoreSummary,
  RepoDigest,
  RepoDigestRow,
  SearchOptions,
  UpdateLoreInput,
} from "./db/types.js";
