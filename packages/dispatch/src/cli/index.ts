#!/usr/bin/env node
// The `dispatch` (`wg`) entry. It stays tiny: turn on the compile cache, then load
// the program, so every module after this one is compiled once and reused by the
// next call. The runner spawns this file dozens of times per tick.
import { enableCompileCache } from "../util/compileCache.js";

import { guardStdio, internalErrorBody, isVersionRequest } from "./stdio.js";

enableCompileCache();
guardStdio();

if (isVersionRequest(process.argv.slice(2))) {
  // What commander's version option prints, and its exit code, without loading it.
  const { VERSION } = await import("../version.js");
  process.stdout.write(`${VERSION}\n`);
  process.exitCode = 0;
} else {
  // A program that cannot load (a broken or partial install) is still the CLI's one
  // JSON error line, not a stack (review finding testspeed-review/R-2).
  void import("./program.js")
    .then(({ buildProgram, runProgram }) => runProgram(buildProgram(), process.argv))
    .then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        process.stderr.write(`${JSON.stringify(internalErrorBody(err))}\n`);
        process.exitCode = 1;
      },
    );
}
