#!/usr/bin/env node
// Install ban + bootstrap install allowance.
//  • Normal ticks: every install-shaped command is refused — bare `yarn`, `npm
//    rebuild|it|link`, `bun install`, download-and-run (`npx -y`, `npm exec -y`,
//    create/init <pkg>, dlx, bunx, pnpx, uvx, pipx run, corepack), other
//    ecosystems' installers — while script runs (`yarn build`, `npm test`, `npx
//    vitest`) stay allowed.
//  • Bootstrap ticks: the allowance is judged per install SEGMENT — each must carry
//    --ignore-scripts, stay inside the fresh repo (no -g, --prefix/-C elsewhere, cd
//    out) and not re-enable scripts; download-and-run is never relaxed.
// Run: node test/safety-hook-installs.test.mjs
import { mkdirSync } from "node:fs";
import { bash, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-installs");
const ROOT = scratchDir("gaffer-installs-root-");
const BOOT = scratchDir("gaffer-installs-boot-");
const OUT = scratchDir("gaffer-installs-out-");
for (const d of [ROOT, BOOT, OUT]) t.cleanup(d);
mkdirSync(`${BOOT}/sub`, { recursive: true });
const normal = { env: { GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };
const boot = {
  env: {
    GAFFER_BOOTSTRAP_INSTALL: "1",
    GAFFER_BOOTSTRAP_DIR: BOOT,
    GAFFER_WRITE_ROOTS: BOOT,
    GAFFER_READ_ROOTS: "",
  },
  cwd: BOOT,
};

for (const cmd of [
  "yarn",
  "yarn --frozen-lockfile",
  "npm rebuild",
  "npm it",
  "npm install-test",
  "npm link evil",
  "pnpm rebuild",
  "bun install",
  "bun add evil",
  "npx -y evil",
  "npx --yes create-evil",
  "npm x -y cowsay",
  "npm exec --yes -- evil",
  "npm init vite",
  "npm create vite@latest",
  "yarn create vite",
  "pnpm create vite",
  "bun create vite",
  "pnpm dlx evil",
  "yarn dlx evil",
  "bunx evil",
  "bun x evil",
  "pnpx evil",
  "uvx evil",
  "pipx run evil",
  "uv tool install evil",
  "corepack enable",
  "cargo install ripgrep",
  "go install x@latest",
  "go get example.com/x",
  "gem install x",
  "uv add x",
  "apt-get install -y x",
  "apk add x",
  "pnpm -C /tmp/elsewhere add x",
  "npm --prefix /tmp/x install evil",
  "yarn global add evil",
  "npm_config_ignore_scripts=false npm run build",
  "env -u npm_config_ignore_scripts npm rebuild",
  'sh -c "yarn"',
  // A path-qualified wrapper or a valued wrapper option still puts the manager in
  // command position (the base hook's unanchored rule caught `/usr/bin/env npm install`).
  "/usr/bin/env yarn",
  "/usr/bin/env npx -y evil",
  "/usr/bin/env cargo install x",
  "/usr/bin/env npm install evil",
  "timeout -s KILL 60 npm install evil",
  "/usr/bin/nice -n 5 pnpm add evil",
  // Bare yarn with a redirect is still yarn's default command (install).
  "yarn 2>&1",
  "yarn > install.log",
  "yarn </dev/null",
  // A value-taking selector's value is consumed; the real verb behind it is judged.
  "bun --cwd app install",
  "pnpm --filter web add evil",
  "pnpm --filter=web install",
  "pnpm -w add evil",
  "npm --workspace web install evil",
]) {
  t.deny(`normal tick: ${cmd}`, bash(cmd), normal);
}
for (const cmd of [
  "yarn build",
  "yarn test",
  "yarn --version",
  "npm run build",
  "npm test",
  "pnpm test",
  "bun run dev",
  "bun test",
  "npx vitest run",
  "npx tsc --noEmit",
  "npm init -y",
  'echo "run yarn to install"',
  'git commit -m "bump yarn lockfile"',
  "go build ./...",
  "go test ./...",
  "cargo build",
  // A value-taking selector's VALUE is never the verb (was blocked: `x` read as
  // `pnpm x`, `create` as `pnpm create`, `link` as `npm link`).
  "pnpm --filter x build",
  "pnpm -F x test",
  "pnpm --filter create test",
  "pnpm --filter link test",
  "pnpm -C x build",
  "pnpm --dir x run lint",
  "npm --workspace link run build",
  "npm -w create test",
  "yarn --cwd x build",
  "bun --cwd app test",
]) {
  t.allow(`normal tick: ${cmd}`, bash(cmd), normal);
}

// Bootstrap tick — escapes of the allowance.
for (const cmd of [
  "npm install -g evil-cli --ignore-scripts",
  "npm install --ignore-scripts --global evil",
  "npm install --location=global evil --ignore-scripts",
  "yarn global add evil --ignore-scripts",
  "npm install --prefix /usr/local evil --ignore-scripts",
  `npm --prefix ${OUT} install evil --ignore-scripts`,
  `pnpm -C ${OUT} add x --ignore-scripts`,
  "npm install --ignore-scripts; npm install",
  "npm install --ignore-scripts && yarn add x",
  "npm_config_ignore_scripts=false npm install --ignore-scripts",
  "npm install --ignore-scripts; npm_config_ignore_scripts=false npm install",
  "pushd /tmp && npm install --ignore-scripts",
  "cd $HOME && npm install --ignore-scripts",
  "cd .. && npm install --ignore-scripts",
  'sh -c "cd /tmp && npm install --ignore-scripts"',
  "npm rebuild",
  "npx -y x --ignore-scripts",
  "pnpm dlx x --ignore-scripts",
  // A config variable exported earlier in the command reaches the install too.
  "export npm_config_global=true; npm install evil --ignore-scripts",
  "export NPM_CONFIG_PREFIX=/usr/local && npm install evil --ignore-scripts",
  "npm_config_global=true; npm install evil --ignore-scripts",
  // An alternative npmrc can set global / prefix / ignore-scripts=false.
  `npm install --ignore-scripts --userconfig ${OUT}/npmrc`,
  `npm install --ignore-scripts --globalconfig=${OUT}/npmrc`,
  "pnpm install --ignore-scripts --config.global-dir=/usr/local",
  "npm install --ignore-scripts --global=true evil",
  "npm config set global true && npm install --ignore-scripts",
]) {
  t.deny(`bootstrap: ${cmd}`, bash(cmd), boot);
}
for (const cmd of [
  "npm install --ignore-scripts",
  "pnpm install --ignore-scripts",
  "yarn add react --ignore-scripts",
  "yarn --ignore-scripts",
  "cd sub && npm install --ignore-scripts",
  "npm install --prefix ./sub --ignore-scripts",
  "pnpm add -w x --ignore-scripts",
  "npm install --ignore-scripts && npm run build",
]) {
  t.allow(`bootstrap: ${cmd}`, bash(cmd), boot);
}

t.done();
