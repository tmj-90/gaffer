#!/usr/bin/env node
// The sandbox probe's answer on a host with a working OS sandbox (GAFFER_SANDBOX_STATUS_CMD
// for the s26-research suite): research may start. No sandbox is used by the canned run.
process.stdout.write(JSON.stringify({ provider: "docker", available: true, required: true, optedOut: false, missing: "", fix: "" }) + "\n");
