#!/usr/bin/env node
// The `dispatch` (`wg`) entry. It stays tiny: turn on the compile cache, then load
// the program, so every module after this one is compiled once and reused by the
// next call. The runner spawns this file dozens of times per tick.
import { enableCompileCache } from "../util/compileCache.js";

import { guardStdio, isVersionRequest } from "./stdio.js";

enableCompileCache();
guardStdio();

if (isVersionRequest(process.argv.slice(2))) {
  // What commander's version option prints, and its exit code, without loading it.
  const { VERSION } = await import("../version.js");
  process.stdout.write(`${VERSION}\n`);
  process.exitCode = 0;
} else {
  const { buildProgram, runProgram } = await import("./program.js");
  void runProgram(buildProgram(), process.argv).then((code) => {
    process.exitCode = code;
  });
}
