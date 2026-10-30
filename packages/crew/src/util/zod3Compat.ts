/**
 * zod 3 compatibility on zod 4 — validation issues (codes, fields and messages as
 * zod 3 reported them) and MCP tool input schemas (published exactly as on zod 3).
 * Shared with Dispatch, which owns the implementation: see
 * packages/dispatch/src/util/zod3Compat.ts. Importing this installs the zod 3
 * error map as zod's global error map.
 */
export { mcpToolInput, toZod3Issues, zod3JsonSchema, type Zod3Issue } from "dispatch/zod3-compat";
