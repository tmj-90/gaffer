// Stub memory CLI for the primeFileCards spawn tests. Behaves per
// STUB_MEMORY_MODE (env):
//   ok      → repo-canonical prints a fixed canonical; cards-for-scope prints
//             the checked-in cards-packet.json (the golden's source packet)
//   exit1   → every subcommand exits 1 (memory unavailable)
//   badjson → cards-for-scope prints non-JSON garbage
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mode = process.env.STUB_MEMORY_MODE ?? "ok";
const cmd = process.argv[2] ?? "";

if (mode === "exit1") process.exit(1);

if (cmd === "repo-canonical") {
  process.stdout.write("example.com/fixture/fixture-app\n");
  process.exit(0);
}
if (cmd === "cards-for-scope") {
  if (mode === "badjson") {
    process.stdout.write("this is not json {");
    process.exit(0);
  }
  process.stdout.write(readFileSync(join(here, "cards-packet.json"), "utf8"));
  process.exit(0);
}
process.exit(1);
