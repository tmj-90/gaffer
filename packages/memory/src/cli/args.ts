/**
 * Tiny CLI flag parser — no external dep. Supports:
 *   --flag value
 *   --flag=value
 *   --repeated-flag a --repeated-flag b → string[]
 *   --bool-flag                          → boolean true
 *   positional args separated cleanly from flags
 *
 * Deliberately limited: not trying to be commander, just enough for the
 * handful of `memory` subcommands.
 */

export interface ParsedArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | string[] | true>>;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | string[] | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    let key = a.slice(2);
    let value: string | undefined;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined) {
      flags[key] = true;
    } else if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      (flags[key] as string[]).push(value);
    } else {
      flags[key] = [flags[key] as string, value];
    }
  }

  return { positionals, flags };
}

/** Coerce a flag value into a string (taking the last value if repeated). */
export function getString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

/** Coerce a flag value into a string[] (zero-or-more). */
export function getStringArray(flags: ParsedArgs["flags"], key: string): string[] {
  const v = flags[key];
  if (v === undefined || v === true) return [];
  if (Array.isArray(v)) return [...v];
  return [v];
}

export function getBool(flags: ParsedArgs["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}
