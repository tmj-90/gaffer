#!/usr/bin/env node
// The `dispatch` (`wg`) entry. It stays tiny: turn on the compile cache, then load
// the program, so every module after this one is compiled once and reused by the
// next call. The runner spawns this file dozens of times per tick.
import { enableCompileCache } from "../util/compileCache.js";

enableCompileCache();
await import("./main.js");
