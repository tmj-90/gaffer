#!/usr/bin/env node
// The `dispatch-api` (dashboard) entry: turn on the compile cache, then load the
// server, so a restart reuses the bytecode of the previous start (see compileCache.ts).
import { enableCompileCache } from "../util/compileCache.js";

enableCompileCache();
await import("./main.js");
