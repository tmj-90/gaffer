#!/usr/bin/env node
import { buildProgram, runProgram } from "./program.js";

void runProgram(buildProgram(), process.argv).then((code) => {
  process.exitCode = code;
});
