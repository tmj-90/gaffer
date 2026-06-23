/**
 * Global test setup. Disable the MCP audit log by default so the suite never
 * writes to `~/.crew/audit.jsonl` on the developer's machine. The
 * dedicated audit tests opt back in by passing an explicit `{ path, env: {} }`
 * to `audit()` / `makeHandlers`, which bypasses this process-level off-switch.
 */
process.env.GAFFER_AUDIT_OFF = "1";
