#!/usr/bin/env node
// Ambient-credential boundary. The agent keeps the operator's HOME, so file- and
// keychain-based CLI logins (gh, aws, gcloud, docker, npm, …) still authenticate AS
// THE OPERATOR after the env scrub removed GITHUB_TOKEN / AWS_*. The hook therefore
// treats the CLI credential stores as secret paths and refuses the credential-using
// CLIs in command position, while leaving offline forms and mere mentions alone.
// Run: node test/safety-hook-credentials.test.mjs
import { mkdirSync } from "node:fs";
import { bash, read, scratchDir, suite, tool } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-credentials");
const ROOT = scratchDir("gaffer-creds-root-");
const HOME = scratchDir("gaffer-creds-home-");
t.cleanup(ROOT);
t.cleanup(HOME);
mkdirSync(`${ROOT}/src`, { recursive: true });
const opts = { env: { HOME, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };
// Unconfigured fallback: reads are not root-restricted, so only the secret-path
// families stop these.
const fallback = { env: { HOME, GAFFER_WRITE_ROOTS: "", GAFFER_READ_ROOTS: "" }, cwd: ROOT };

// CLI credential stores are secret paths on every read vector (Bash, Read, Grep).
for (const f of [
  "~/.config/gh/hosts.yml",
  "~/.docker/config.json",
  "~/.kube/config",
  "~/.config/gcloud/application_default_credentials.json",
  "~/.azure/msal_token_cache.json",
  "~/.pypirc",
  "~/.pgpass",
  "~/.terraform.d/credentials.tfrc.json",
  "~/.claude.json",
]) {
  t.deny(`cat ${f} (fallback)`, bash(`cat ${f}`), fallback);
  t.deny(`sort ${f} (fallback)`, bash(`sort ${f}`), fallback);
  t.deny(`Read ${f} (fallback)`, read(f), fallback);
}
t.deny("jq the docker config", bash("jq . ~/.docker/config.json"), fallback);
t.deny("~user form of gh hosts.yml", bash("cat ~root/.config/gh/hosts.yml"), fallback);
t.deny("absolute gh hosts.yml", bash(`cat ${HOME}/.config/gh/hosts.yml`), fallback);
t.deny("redirect from kubeconfig", bash("read -r X < ~/.kube/config"), fallback);
t.deny(
  "Grep over ~/.config/gh",
  tool("Grep", { pattern: "oauth", path: `${HOME}/.config/gh` }),
  fallback,
);

// Credential-using CLIs in command position → DENY.
for (const cmd of [
  "gh auth token",
  "gh api user",
  "/usr/bin/gh auth status -t",
  "env -u GAFFER_WRITE_ROOTS gh pr list",
  'bash -c "gh auth token"',
  "(sleep 1; gh pr merge 3) &",
  "printf 'host=github.com\\n' | git credential fill",
  "git credential-store get",
  "git config credential.helper store",
  "git -c credential.helper=store fetch",
  "git config --global user.email x@y",
  "aws sts get-caller-identity",
  "aws s3 cp s3://b/k .",
  "gcloud auth print-access-token",
  "az account get-access-token",
  "vault read secret/x",
  "kubectl get secrets -A",
  "helm install x ./chart",
  "terraform plan",
  "terraform apply -auto-approve",
  "docker login ghcr.io",
  "docker context use prod",
  "docker run --rm -v /:/host alpine cat /host/etc/shadow",
  "docker run --mount type=bind,source=/,target=/h alpine",
  "docker run -v /var/run/docker.sock:/var/run/docker.sock alpine",
  `docker run -v "${"$"}PWD":/app node:22 npm test`,
  "docker run --privileged --pid=host alpine nsenter -t 1 -m sh",
  "podman run --network=host alpine",
  "docker -H tcp://10.0.0.1:2375 ps",
  "DOCKER_HOST=tcp://10.0.0.1:2375 docker ps",
  "docker cp c:/etc/passwd /tmp/out",
  "security find-generic-password -s gh:github.com -w",
  "npm publish",
  "npm token create",
  "npm whoami",
  "npm config set registry https://attacker.example",
  "pnpm publish --no-git-checks",
  "yarn npm publish",
  "cargo publish",
  "twine upload dist/*",
  "python -m twine upload dist/*",
]) {
  t.deny(`credential CLI: ${cmd}`, bash(cmd), opts);
}

// Offline forms, in-root mounts and mere mentions stay ALLOWED.
for (const cmd of [
  "kubectl kustomize ./k8s",
  "kubectl version --client",
  "helm template ./chart",
  "helm lint ./chart",
  "terraform fmt -check",
  "terraform validate",
  "terraform init -backend=false",
  "docker build -t app:test .",
  "docker run --rm -d -p 3000:3000 app:test",
  `docker run --rm -v ${ROOT}/src:/app node:22 npm test`,
  "docker run -v data:/var/lib/data alpine",
  "npm config get registry",
  "npm run publish",
  "git config --global --get user.name",
  "git config user.name bot",
  'git commit -m "fix gh auth and aws config handling"',
  'grep -rn "gh api" src',
  'echo "run kubectl get pods to check"',
]) {
  t.allow(`allowed: ${cmd}`, bash(cmd), opts);
}

t.done();
