#!/usr/bin/env node
import { buildProgram, guardStdio, runProgram } from "./program.js";

guardStdio();

void runProgram(buildProgram(), process.argv).then((code) => {
  process.exitCode = code;
});
