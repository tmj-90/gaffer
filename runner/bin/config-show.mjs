#!/usr/bin/env node
// gaffer config show [--all] [--json]: the fourteen settings with their values and
// where each came from; --all adds every value they derive and what decided it.
//
// Read-only and safe for an agent to run: it reads what `runner/gaffer` already
// sourced (factory.config.sh), handed over on stdin as tab-separated lines, plus the
// tables in runner/config/settings-schema.json. It writes nothing and starts nothing,
// and it never prints a secret: a webhook URL, a token or a key shows that it is set,
// not its value.
//
// stdin, one record per line (values have no tabs or newlines):
//   S <name> <origin: environment|settings.json|default> <value>
//   D <name> <origin: environment|settings.json|derived> <set: 1|0> <value>
//   M <key> <old value> <setting> <derived value> <decision>
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(HERE, "..", "config", "settings-schema.json");

/** A name whose value may hold a credential: never printed, only "set" or "not set". */
export function isSecretName(name) {
  return /TOKEN|SECRET|PASSWORD|API_KEY|WEBHOOK|SLACK|NOTIFY_.*URL|^GAFFER_NOTIFY$/.test(name);
}

/** What a secret value shows instead of itself. GAFFER_NOTIFY lists its channels. */
export function shown(name, value) {
  if (!isSecretName(name)) return value;
  if (value === "") return "";
  if (name === "GAFFER_NOTIFY") {
    return value
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((it) =>
        it === "desktop"
          ? "desktop"
          : it.startsWith("https://hooks.slack.com/")
            ? "a Slack URL (hidden)"
            : /^https?:\/\//.test(it)
              ? "a webhook URL (hidden)"
              : "(hidden)",
      )
      .join(", ");
  }
  return "(set, hidden)";
}

/** Parse the records `runner/gaffer config` writes. */
export function parseRecords(text) {
  const settings = new Map();
  const derived = new Map();
  const migration = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "S") settings.set(f[1], { origin: f[2], value: f[3] ?? "" });
    else if (f[0] === "D")
      derived.set(f[1], { origin: f[2], set: f[3] === "1", value: f[4] ?? "" });
    else if (f[0] === "M")
      migration.push({
        key: f[1],
        old: f[2] ?? "",
        setting: f[3],
        derived: f[4] ?? "",
        decision: f[5],
      });
  }
  return { settings, derived, migration };
}

const DECISION = {
  kept: "the old value still applies (it is stricter than what the setting derives, or the setting leaves it unset)",
  "stricter-derived": "ignored (the old value was more permissive or costlier)",
  same: "ignored (the setting derives the same value)",
  ignored: "ignored (the setting decides it)",
  environment: "ignored (the environment sets it)",
};

/** The report as one object (the --json form). */
export function report(schema, recs, { all }) {
  const settings = schema.settings.map((s) => {
    const r = recs.settings.get(s.name) ?? { origin: "default", value: "" };
    // A default written "(none)" in the spec is no value at all.
    const value = r.value !== "" ? r.value : s.default.startsWith("(") ? "" : s.default;
    return { name: s.name, value: shown(s.name, value), origin: r.origin };
  });
  const out = { settings };
  if (all) {
    out.derived = [];
    for (const s of schema.settings) {
      const sv = recs.settings.get(s.name)?.value || (s.default.startsWith("(") ? "" : s.default);
      for (const d of s.derives) {
        const r = recs.derived.get(d.name) ?? { origin: "derived", set: false, value: "" };
        const constant = d.all ?? null;
        let value = r.value;
        let note;
        if (!r.set) {
          if (constant && constant.how === "value" && constant.readIn) {
            value = constant.value;
            note = `read with this default in ${constant.readIn}`;
          } else if (constant && constant.how === "follows") {
            const f = recs.derived.get(constant.name) ?? recs.settings.get(constant.name);
            value = f && (f.set ?? true) ? f.value : null;
            note = `follows ${constant.name}`;
          } else {
            value = null;
          }
        }
        const decidedBy =
          r.origin === "environment"
            ? "environment"
            : r.origin === "settings.json"
              ? "settings.json (an old key, stricter than the setting)"
              : sv === ""
                ? `${s.name} (none)`
                : `${s.name}=${shown(s.name, sv)}`;
        const row = {
          name: d.name,
          value: value === null ? null : shown(d.name, value),
          decidedBy,
          setting: s.name,
        };
        if (note) row.note = note;
        out.derived.push(row);
      }
    }
  }
  out.migration = recs.migration.map((m) => ({
    key: m.key,
    setting: m.setting,
    old: shown(m.key, m.old),
    derived: shown(m.key, m.derived),
    differs: m.old !== m.derived,
    decision: m.decision,
  }));
  return out;
}

/** The report as text for a person. */
export function renderText(rep) {
  const lines = [];
  const w = Math.max(...rep.settings.map((s) => s.name.length));
  lines.push("Settings (the fourteen):");
  for (const s of rep.settings) {
    lines.push(`  ${s.name.padEnd(w)}  ${s.value === "" ? "(none)" : s.value}  [${s.origin}]`);
  }
  if (rep.derived) {
    lines.push("", "Derived values (what decided each):");
    const dw = Math.max(...rep.derived.map((d) => d.name.length));
    let last = "";
    for (const d of rep.derived) {
      if (d.setting !== last) {
        lines.push(`  ${d.setting}:`);
        last = d.setting;
      }
      const v = d.value === null ? "(unset)" : d.value === "" ? "(empty)" : d.value;
      lines.push(`    ${d.name.padEnd(dw)}  ${v}  [${d.decidedBy}${d.note ? `; ${d.note}` : ""}]`);
    }
  }
  if (rep.migration.length > 0) {
    lines.push("", "Old settings.json keys (no longer settings):");
    for (const m of rep.migration) {
      lines.push(`  ${m.key} -> ${m.setting}: ${DECISION[m.decision] ?? m.decision}`);
    }
  }
  if (!rep.derived)
    lines.push("", "gaffer config show --all adds every derived value and what decided it.");
  return `${lines.join("\n")}\n`;
}

async function main(argv) {
  const all = argv.includes("--all");
  const json = argv.includes("--json");
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  let input = "";
  for await (const c of process.stdin) input += c;
  const rep = report(schema, parseRecords(input), { all });
  process.stdout.write(json ? `${JSON.stringify(rep, null, 2)}\n` : renderText(rep));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`gaffer config: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
