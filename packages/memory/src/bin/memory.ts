#!/usr/bin/env node
import { main } from "../cli/index.js";
import { DatabaseTooNewError } from "../db/migrations.js";

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof DatabaseTooNewError) {
      process.stderr.write(`memory: ${err.message}\n`);
    } else {
      process.stderr.write(
        `memory: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
    }
    process.exit(1);
  });
