/* global document */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// The parameterised views the golden sweep does not reach — #/create, #/epics/:id,
// #/specs/:id and #/node/:id — rendered at every width the golden layout sweep uses
// (320, 360, 390, 768, 1024, 1280, 1440): each must fit the viewport (no sideways
// scroll, header controls on screen, icons sized), log no console error and pass the
// WCAG 2.1 A/AA gate at that width. The epic, spec and ground are seeded over REST.
export default async function sweep(t, L) {
  const tagged = L.tag("sw");
  const epic = (
    await L.api("POST", "/epics", {
      epic: {
        name: `Sweep epic ${tagged}`,
        description: "seeded for the layout sweep",
        brief: "a sweep",
      },
      tickets: [
        {
          title: `Sweep first ${tagged}`,
          description: "one",
          acceptanceCriteria: ["it works"],
          repo: t.repo.name,
          dependsOn: [],
        },
        {
          title: `Sweep second ${tagged}`,
          description: "two",
          acceptanceCriteria: ["it still works"],
          repo: t.repo.name,
          dependsOn: [0],
        },
      ],
    })
  ).json;
  const epicId = epic.epic_node_id || epic.epic?.id || epic.node?.id;
  for (const x of (await L.listTickets()).filter((k) => k.title.includes(tagged)))
    t.created.add(x.id);
  const spec = (
    await L.api("POST", "/specs", {
      title: `Sweep spec ${tagged}`,
      target_repo: t.repo.name,
      clauses: [
        {
          clause_id: "c1",
          kind: "requirement",
          text: "a long requirement clause that has to wrap on a phone without pushing the page sideways",
        },
        { clause_id: "c2", kind: "non-goal", text: "no timers" },
      ],
    })
  ).json.spec;
  const node = (
    await L.api("POST", "/scope/nodes", {
      name: `Sweep ground ${tagged}`,
      type: "product",
      risk_level: "low",
    })
  ).json.node;
  const views = [
    ["create", "create"],
    epicId ? [`epics/${epicId}`, "epics/:id"] : null,
    spec ? [`specs/${spec.id}`, "specs/:id"] : null,
    node ? [`node/${node.id}`, "node/:id"] : null,
  ].filter(Boolean);
  t.check(
    views.length === 4,
    "seeded an epic, a spec and a ground for the sweep (POST /epics, /specs, /scope/nodes)",
    `sweep seeds: epic=${Boolean(epicId)} spec=${Boolean(spec)} node=${Boolean(node)}`,
  );

  for (const [w, h] of [
    [320, 640],
    [360, 780],
    [390, 844],
    [768, 1000],
    [1024, 768],
    [1280, 800],
    [1440, 900],
  ]) {
    const pg = await L.openPage(t.browser, { width: w, height: h });
    const problems = [];
    for (const [route, label] of views) {
      const before = pg.consoleErrors.length;
      await pg.goto(`${L.BASE}/#/${route}`, { waitUntil: "load" });
      await pg
        .waitForFunction(
          () => (document.querySelector("#app")?.textContent || "").trim().length > 50,
          null,
          { timeout: 15000 },
        )
        .catch(() => null);
      await L.sleep(900);
      problems.push(...(await L.layoutProblems(pg, label)));
      const errs = pg.consoleErrors.slice(before);
      if (errs.length) problems.push(`${label}@${w} console: ${errs.join(" | ").slice(0, 160)}`);
      await L.auditA11y(pg, `${label}@${w}`, t);
    }
    problems.length
      ? t.bad(`layout @${w}px: ${problems.join("; ")}`)
      : t.ok(
          `layout @${w}px: ${views.map((v) => v[1]).join(", ")} fit (no sideways scroll, header controls on screen, icons sized, no console errors)`,
        );
    if (w === 390) await L.shot(pg, "sweep-390-epic");
    await pg.context().close();
  }
}
