// S14 map scopes. A product ground is made from the Map's New ground; a repo is
// linked to it from the ground's page and a depends_on connection added to a second
// ground; a second repo is hidden from the Map, found on #/hidden and unhidden; the
// repo page's default branch is changed and put back; a ticket scoped only to the
// ground is refused at Mark ready (the ground's repos are only suggestions) until its
// suggested repo is confirmed on the ticket's boundary.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export default async function s14(t, L) {
  const p = t.page;
  const name = `Task Platform ${L.tag("g")}`;

  // ── New ground from the Map ───────────────────────────────────────────────
  await t.visit("factory");
  await p.locator('.view button:has-text("New ground")').click();
  await p.waitForSelector('input[placeholder="e.g. Trading Platform"]', { timeout: 10000 });
  await p.fill('input[placeholder="e.g. Trading Platform"]', name);
  const typeSel = p.locator("form select").first();
  const opts = await typeSel.locator("option").evaluateAll((os) => os.map((o) => o.value));
  if (opts.includes("product")) await typeSel.selectOption("product");
  const resP = p.waitForResponse(
    (r) => r.url().endsWith("/scope/nodes") && r.request().method() === "POST",
    { timeout: 10000 },
  );
  await p.locator('button:has-text("Create ground")').click();
  const res = await resP.catch(() => null);
  const nodes = (await L.api("GET", "/scope/nodes")).json.nodes || [];
  const node = nodes.find((n) => n.name === name);
  t.check(
    res && res.status() < 300 && node,
    `New ground created '${name}' (POST /scope/nodes, type ${node?.type})`,
    `New ground: ${res && res.status()} found=${Boolean(node)}`,
  );
  if (!node) return;

  // ── link the sample repo + a depends_on connection, from the ground's page ─
  const other = (
    await L.api("POST", "/scope/nodes", {
      name: `Billing ${L.tag("g")}`,
      type: "product",
      risk_level: "low",
    })
  ).json.node;
  await t.visit(`node/${node.id}`, { label: "node/:id" });
  const linkForm = p.locator('form:has(button:has-text("Link repo"))');
  await L.maybe(
    async () => (await linkForm.locator("select").first().locator("option").count()) > 1,
    "repo options",
    10000,
    300,
  );
  await linkForm.locator("select").first().selectOption(t.repo.id);
  await L.clearToast(p);
  await linkForm.locator('button:has-text("Link repo")').click();
  const linked = await L.waitToast(p, /Repo linked/, 8000);
  const scopeRepos = (await L.api("GET", `/repos/${t.repo.id}/scopes`)).json;
  const links = scopeRepos.scopes || scopeRepos.links || [];
  t.check(
    linked && JSON.stringify(links).includes(node.id),
    `the ground's Link repo linked ${t.repo.name} (write) to '${name}'`,
    `link repo: toast=${linked} repo scopes=${JSON.stringify(links).slice(0, 160)}`,
  );
  await t.visit(`node/${node.id}`, { label: "node/:id" });
  const edgeForm = p.locator('form:has(button:has-text("Add connection"))');
  if (other) {
    await edgeForm.locator("select").first().selectOption(other.id);
    await edgeForm.locator("select").nth(1).selectOption("depends_on");
    await L.clearToast(p);
    await edgeForm.locator('button:has-text("Add connection")').click();
    const added = await L.waitToast(p, /Connection added/, 8000);
    const edges = (await L.api("GET", "/scope/edges")).json.edges || [];
    t.check(
      added &&
        edges.some(
          (e) =>
            e.from_node_id === node.id && e.to_node_id === other.id && e.relation === "depends_on",
        ),
      `Add connection recorded '${name}' depends_on '${other.name}'`,
      `add connection: toast=${added} edges=${JSON.stringify(edges).slice(0, 200)}`,
    );
  } else t.bad("could not seed the second ground for the connection");
  await t.visit("factory");
  const mapTxt = (await p.textContent(".view").catch(() => "")) || "";
  t.check(mapTxt.includes(name), "the Map draws the new ground", `the Map does not show '${name}'`);

  // ── a second repo: hide from the Map, find on #/hidden, unhide ────────────
  const r2path = path.join(path.dirname(L.REPO_PATH), `side-repo-${L.tag("r")}`);
  mkdirSync(r2path, { recursive: true });
  writeFileSync(path.join(r2path, "README.md"), "# side repo\n");
  L.git(r2path, "init", "-q", "-b", "main");
  L.git(r2path, "add", "-A");
  L.git(r2path, "commit", "-qm", "init");
  const r2name = path.basename(r2path);
  execFileSync(
    "node",
    [
      path.join(L.ROOT, "packages/dispatch/dist/cli/index.js"),
      "--db",
      path.join(L.GAFFER_DATA, "dispatch.sqlite"),
      "repo",
      "add",
      "--name",
      r2name,
      "--path",
      r2path,
    ],
    { timeout: 60000 },
  );
  await t.visit("factory");
  // Hide asks window.confirm first; accept it as an operator would.
  p.once("dialog", (d) => d.accept());
  await p.locator(`button[aria-label="Hide ${r2name} from the dashboard"]`).first().click();
  const hidden = await L.maybe(
    async () =>
      ((await L.api("GET", "/repositories?hidden=1")).json.repositories || []).find(
        (r) => r.name === r2name && r.hidden,
      ) || null,
    "repo hidden",
    8000,
    400,
  );
  await t.visit("factory");
  const after = (await p.textContent(".view").catch(() => "")) || "";
  t.check(
    hidden && !after.includes(r2name),
    `Hide took ${r2name} off the Map (it stays registered)`,
    `hide: hidden=${Boolean(hidden)} still on Map=${after.includes(r2name)}`,
  );
  await t.visit("hidden");
  const unhide = p.locator(`button[aria-label="Unhide ${r2name}"]`);
  t.check(
    await unhide.count(),
    `#/hidden lists ${r2name} with an Unhide button`,
    `#/hidden has no Unhide for ${r2name}`,
  );
  if (await unhide.count()) {
    await unhide.click();
    const back = await L.maybe(
      async () =>
        ((await L.api("GET", "/repositories")).json.repositories || []).some(
          (r) => r.name === r2name,
        ),
      "unhidden",
      8000,
      400,
    );
    t.check(
      back,
      `Unhide returned ${r2name} to the repo list`,
      `${r2name} still hidden after Unhide`,
    );
  }

  // ── repo page: default branch edit and back ───────────────────────────────
  L.git(L.REPO_PATH, "branch", "-f", "trunk", "main");
  await t.visit(`repo/${encodeURIComponent(t.repo.id)}`, { label: "repo/:id" });
  // Edit asks with window.prompt; answer it.
  const setBranch = async (b) => {
    p.once("dialog", (d) => d.accept(b));
    const rp = p.waitForResponse((r) => r.url().endsWith(`/repos/${t.repo.id}/default-branch`), {
      timeout: 10000,
    });
    await p.locator(`button[aria-label="Edit default branch for ${t.repo.name}"]`).click();
    return rp.catch(() => null);
  };
  const br = await setBranch("trunk");
  const nowB = ((await L.api("GET", "/repositories")).json.repositories || []).find(
    (r) => r.id === t.repo.id,
  )?.default_branch;
  t.check(
    br && br.status() < 300 && nowB === "trunk",
    "the repo page changed the default branch to 'trunk' (POST /repos/:id/default-branch)",
    `default branch edit: ${br && br.status()} now=${nowB}`,
  );
  await t.visit(`repo/${encodeURIComponent(t.repo.id)}`, { label: "repo/:id" });
  await setBranch("main");
  await L.api("POST", `/repos/${t.repo.id}/default-branch`, { default_branch: "main" });

  // ── a ticket scoped only to the ground: refused until a repo is confirmed ─
  const tk = (
    await L.api("POST", "/tickets", {
      title: `Scoped to the ground (${L.tag("s14")})`,
      description: "scope-only",
      scopeNodeIds: [node.id],
    })
  ).json.ticket;
  t.created.add(tk.id);
  await L.api("POST", `/tickets/${tk.id}/acceptance-criteria`, { text: "covered by a test" });
  await t.visit(`ticket/${tk.id}`);
  await p.locator('button:has-text("Mark ready")').first().click();
  const refusal = await L.maybe(
    async () => {
      const txt = (await p.textContent(".policy-result.fail").catch(() => "")) || "";
      return txt ? txt : null;
    },
    "readiness refusal",
    10000,
    300,
  );
  t.check(
    refusal &&
      /SCOPE_REPO_UNCONFIRMED|none of its repos is confirmed/.test(refusal) &&
      (await L.ticketOf(tk.id)).status === "draft",
    "Mark ready on a ground-only ticket is refused: the ground's repos are only suggestions (SCOPE_REPO_UNCONFIRMED)",
    `scope-only ready: '${(refusal || "").slice(0, 160)}' status=${(await L.ticketOf(tk.id)).status}`,
  );
  const confirm = p.locator('.repo-group-suggested button:has-text("Confirm")').first();
  const hasSug = await confirm.waitFor({ timeout: 10000 }).then(
    () => true,
    () => false,
  );
  t.check(
    hasSug,
    `the ticket's boundary suggests ${t.repo.name} from the ground, with Confirm`,
    "no suggested repo on the scope-only ticket's boundary",
  );
  if (hasSug) {
    await confirm.click();
    await L.sleep(1200);
    await t.visit(`ticket/${tk.id}`);
    await p.locator('button:has-text("Mark ready")').first().click();
    const ok = await L.waitStatus(tk.id, ["ready"], 10000, 400);
    t.check(
      ok,
      "after confirming the suggested repo, Mark ready passes",
      `after Confirm, Mark ready left #${tk.number} '${(await L.ticketOf(tk.id)).status}'`,
    );
    await L.api("POST", `/tickets/${tk.id}/move`, { to: "draft" });
  }
}
