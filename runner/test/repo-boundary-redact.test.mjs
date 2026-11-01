// Remote URL credential stripping (external review #9, finding 3): every secret in a
// URL's userinfo is removed before it can reach a prompt, digest, event or log line.
// An ssh login name stays (it is not a secret); an ssh password does not.
// Run: node runner/test/repo-boundary-redact.test.mjs
import { redactRemoteUrl, redactUrlsIn } from "../lib/repo-boundary.mjs";

let passed = 0;
const failures = [];
const eq = (label, got, want) => {
  if (got === want) passed += 1;
  else failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

eq("https user:pass", redactRemoteUrl("https://bob:hunter2@github.com/a/w.git"), "https://github.com/a/w.git");
eq("https token only", redactRemoteUrl("https://tok@github.com/a/w"), "https://github.com/a/w");
eq("raw @ in the password", redactRemoteUrl("https://u:p@ss@host/x"), "https://host/x");
eq("percent-encoded userinfo", redactRemoteUrl("https://u%3Ap:t%40k@h/x"), "https://h/x");
eq("ssh login kept", redactRemoteUrl("ssh://git@host/r.git"), "ssh://git@host/r.git");
eq("ssh password dropped", redactRemoteUrl("ssh://git:s3cret@host/r.git"), "ssh://git@host/r.git");
eq("git+ssh password dropped", redactRemoteUrl("git+ssh://git:s3cret@host/r"), "git+ssh://git@host/r");
eq("scp form kept", redactRemoteUrl("git@github.com:a/w.git"), "git@github.com:a/w.git");
eq("no userinfo", redactRemoteUrl("https://github.com/a/w"), "https://github.com/a/w");

const line = redactUrlsIn("fetch https://u:p@ss@host/x and ssh://git:s3cret@h/r then https://tok@h2/y");
for (const secret of ["p@ss", "ss@host", "s3cret", "tok@"]) {
  eq(`log line drops ${secret}`, line.includes(secret), false);
}
eq("log line keeps hosts and the ssh login", line, "fetch https://host/x and ssh://git@h/r then https://h2/y");

if (failures.length) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  x " + f);
  process.exit(1);
}
console.log(`PASS — ${passed} checks passed`);
