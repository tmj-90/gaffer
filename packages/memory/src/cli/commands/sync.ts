/**
 * Sync commands: `sync export`, `sync import`, `sync pull`.
 *
 * These commands manage the PR-reviewable team lore workflow: exporting
 * records to .md files, importing them back, and recursively pulling from
 * all .memory/ directories under a parent directory.
 */
import { existsSync } from "node:fs";

import { openDb } from "../../db/index.js";
import { getBool, parseArgs } from "../args.js";
import { exportToDir, findMemoryDirs, importFromDir } from "../sync.js";

/**
 * `memory sync pull <parent>` — recursively discover every
 * `.memory/` directory under `<parent>` and run `importFromDir`
 * on each one. The "one machine, all my repos" cross-repo win: a
 * developer who works in ~/code with N repos that each ship a
 * `.memory/` runs this once and their local DB is populated
 * with everything those teams have committed.
 *
 * Bounded scan: skips common heavy directories (`node_modules`,
 * `.git`, `dist`, `build`, `target`, `vendor`, `.next`, `.cache`)
 * to avoid eating the filesystem. Doesn't descend into a discovered
 * `.memory/` itself (its contents are the records, not nested
 * caches).
 */
async function cmdSyncPull(args: ReturnType<typeof parseArgs>, parentDir: string): Promise<number> {
  const { resolve } = await import("node:path");
  const absParent = resolve(parentDir);
  if (!existsSync(absParent)) {
    process.stderr.write(`memory: sync pull — parent directory not found: ${absParent}\n`);
    return 2;
  }
  const found = findMemoryDirs(absParent);
  if (found.length === 0) {
    process.stdout.write(`memory: sync pull — no .memory/ directories found under ${absParent}\n`);
    return 0;
  }
  const includeRestricted = getBool(args.flags, "include-restricted");
  const force = getBool(args.flags, "force");
  const dryRun = getBool(args.flags, "dry-run");
  const db = openDb();
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkippedNewer = 0;
  let totalRejected = 0;
  let totalDangling = 0;
  let totalBoundaries = 0;
  try {
    process.stdout.write(
      `memory: sync pull — found ${found.length} .memory/ ${found.length === 1 ? "directory" : "directories"} under ${absParent}\n`,
    );
    for (const d of found) {
      const r = importFromDir(db, d, { includeRestricted, force, dryRun });
      totalCreated += r.created;
      totalUpdated += r.updated;
      totalSkippedNewer += r.skippedNewer;
      totalRejected += r.skipped.length;
      totalDangling += r.danglingSupersededBy.length;
      totalBoundaries += r.boundariesCreated + r.boundariesUpdated;
      const verb = r.dryRun ? "would import" : "imported";
      process.stdout.write(
        `  ${d}: ${verb} ${r.created} new + ${r.updated} updated` +
          (r.skippedNewer > 0 ? `, skipped ${r.skippedNewer} (local newer)` : "") +
          (r.skipped.length > 0 ? `, rejected ${r.skipped.length}` : "") +
          "\n",
      );
      if (r.danglingSupersededBy.length > 0) {
        for (const dd of r.danglingSupersededBy) {
          process.stderr.write(
            `    WARNING dangling supersededBy: ${dd.file} ${dd.id} → ${dd.supersededBy}\n`,
          );
        }
      }
    }
    const verb = dryRun ? "would import" : "imported";
    process.stdout.write(
      `\nmemory: ${verb} ${totalCreated} new + ${totalUpdated} updated across ${found.length} ${found.length === 1 ? "directory" : "directories"}` +
        (totalSkippedNewer > 0 ? `; ${totalSkippedNewer} skipped as newer locally` : "") +
        (totalRejected > 0 ? `; ${totalRejected} rejected` : "") +
        (totalBoundaries > 0 ? `; ${totalBoundaries} boundary edge(s)` : "") +
        (totalDangling > 0 ? `; ${totalDangling} dangling supersededBy refs (see warnings)` : "") +
        (dryRun ? " (dry-run — no changes written)" : "") +
        "\n",
    );
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdSync(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  const dir = args.positionals[1];
  if (sub !== "export" && sub !== "import" && sub !== "pull") {
    process.stderr.write(
      "memory: sync requires a subcommand — `memory sync export <dir>`, `memory sync import <dir>`, or `memory sync pull <parent-dir>`\n",
    );
    return 2;
  }
  if (!dir) {
    process.stderr.write(`memory: sync ${sub} requires a directory path\n`);
    return 2;
  }
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeSuperseded = getBool(args.flags, "include-superseded");
  const includeRestricted = getBool(args.flags, "include-restricted");
  if (sub === "pull") {
    return await cmdSyncPull(args, dir);
  }
  const db = openDb();
  try {
    if (sub === "export") {
      const clean = getBool(args.flags, "clean");
      const r = exportToDir(db, dir, {
        includeDrafts,
        includeDeprecated,
        includeSuperseded,
        includeRestricted,
        clean,
      });
      if (r.removed.length > 0) {
        process.stdout.write(
          `memory: removed ${r.removed.length} stale <id>.md file(s) before writing\n`,
        );
      }
      process.stdout.write(`memory: wrote ${r.written.length} record(s) to ${dir}\n`);
      if (r.boundariesWritten > 0) {
        process.stdout.write(
          `  including ${r.boundariesWritten} boundary edge(s) → ${dir}/boundaries.jsonl\n`,
        );
      }
      if (r.restrictedWritten > 0) {
        process.stderr.write(
          `memory: WARNING — ${r.restrictedWritten} restricted record(s) written to ${dir}.\n` +
            `  Each file was chmod'd to 0600, but the directory itself is not locked down.\n` +
            `  Do NOT commit these files unless your repo is private and you accept the risk.\n`,
        );
      }
      if (r.excluded.restricted > 0) {
        process.stdout.write(
          `  ${r.excluded.restricted} restricted record(s) held back (pass --include-restricted to include)\n`,
        );
      }
      if (r.excluded.drafts > 0) {
        process.stdout.write(
          `  ${r.excluded.drafts} draft(s) held back (pass --include-drafts to include)\n`,
        );
      }
      return 0;
    }
    // import
    const force = getBool(args.flags, "force");
    const dryRun = getBool(args.flags, "dry-run");
    const r = importFromDir(db, dir, {
      includeRestricted,
      force,
      dryRun,
    });
    const verb = r.dryRun ? "would import" : "imported";
    process.stdout.write(
      `memory: ${verb} ${r.created} new + ${r.updated} updated record(s) from ${dir}\n`,
    );
    if (r.boundariesCreated > 0 || r.boundariesUpdated > 0) {
      process.stdout.write(
        `  ${verb} ${r.boundariesCreated} new + ${r.boundariesUpdated} updated boundary edge(s)\n`,
      );
    }
    if (r.skippedNewer > 0) {
      process.stdout.write(
        `  ${r.skippedNewer} record(s) skipped — local copy is newer (pass --force to overwrite)\n`,
      );
    }
    if (r.danglingSupersededBy.length > 0) {
      process.stderr.write(
        `  WARNING — ${r.danglingSupersededBy.length} record(s) reference a supersededBy id that doesn't exist locally:\n`,
      );
      for (const d of r.danglingSupersededBy) {
        process.stderr.write(
          `    ${d.file}: ${d.id} → ${d.supersededBy} (dead reference until the target lands)\n`,
        );
      }
    }
    if (r.skipped.length > 0) {
      process.stdout.write(`  rejected ${r.skipped.length} file(s):\n`);
      for (const s of r.skipped) {
        process.stdout.write(`    ${s.file}: ${s.reason}\n`);
      }
    }
    if (r.dryRun) {
      process.stdout.write(`  (dry-run — no changes written)\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}
