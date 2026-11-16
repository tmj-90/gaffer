#!/usr/bin/env node
// Every agent the DASHBOARD starts must not see a notify endpoint. The dashboard keeps
// GAFFER_NOTIFY (the setting: webhook and Slack URLs with their tokens) and the names it
// derives (GAFFER_NOTIFY_*_URL ...) in its own environment for its notifier, each with the
// runner's re-source record (_GAFFER_DV_<NAME>, the same value). The planner behind Plan a
// build (decompose.mjs) and the spec author stripped credentials but no endpoint, and the
// Suggest work / onboarding / merge-resolver scrubs missed the record of GAFFER_NOTIFY
// itself. A prompt-injected agent that can read a webhook URL can post as the factory.
// Run: node runner/test/dashboard-agent-notify-scrub.test.mjs
import { agentChildEnv as decompose } from "../bin/decompose.mjs";
import { agentChildEnv as specAuthor } from "../bin/spec-author.mjs";
import { agentChildEnv as productOwner } from "../bin/product-owner-run.mjs";
import { agentChildEnv as onboard } from "../lib/onboard-analyze.mjs";
import { buildChildEnv as mergeResolver } from "../bin/merge-ticket.mjs";

const SLACK = "https://hooks.slack.com/services/T000/B000/secret-token";
const HOOK = "https://hooks.example.com/w/secret-token";
// What a dashboard's environment holds once GAFFER_NOTIFY is saved in Settings.
const dashboardEnv = {
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "sk-ant-keepme",
  GAFFER_MODE: "supervised",
  GAFFER_NOTIFY: `desktop,${HOOK},${SLACK}`,
  _GAFFER_DV_GAFFER_NOTIFY: `desktop,${HOOK},${SLACK}`,
  GAFFER_NOTIFY_WEBHOOK_URL: HOOK,
  _GAFFER_DV_GAFFER_NOTIFY_WEBHOOK_URL: HOOK,
  GAFFER_NOTIFY_SLACK_URL: SLACK,
  _GAFFER_DV_GAFFER_NOTIFY_SLACK_URL: SLACK,
  GAFFER_NOTIFY_DESKTOP: "1",
};

let passed = 0;
const failures = [];
const launchers = {
  "Plan a build (decompose.mjs)": decompose,
  "spec author (spec-author.mjs)": specAuthor,
  "Suggest work (product-owner-run.mjs)": productOwner,
  "onboarding analysis (onboard-analyze.mjs)": onboard,
  "merge resolver (merge-ticket.mjs)": (e) =>
    mergeResolver(e, { dispatchDb: "/d.db", memoryDb: "/m.db", writeRoot: "/w" }),
};
for (const [name, build] of Object.entries(launchers)) {
  const env = build({ ...dashboardEnv });
  const text = JSON.stringify(env);
  const leaked = Object.keys(env).filter((k) => /NOTIFY/.test(k));
  if (text.includes("secret-token") || leaked.length > 0) {
    failures.push(`${name}: a notify endpoint reached the agent (${leaked.join(", ") || "a URL"})`);
  } else passed++;
  if (env.ANTHROPIC_API_KEY !== "sk-ant-keepme" || env.PATH !== "/usr/bin") {
    failures.push(`${name}: the scrub dropped what the agent needs (PATH, its auth)`);
  } else passed++;
  if (env.GAFFER_MODE !== "supervised") {
    failures.push(`${name}: a plain setting was dropped`);
  } else passed++;
}

if (failures.length) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(`dashboard-agent-notify-scrub: ${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log(`dashboard-agent-notify-scrub: ALL ${passed} checks passed`);
