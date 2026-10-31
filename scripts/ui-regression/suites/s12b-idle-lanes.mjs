// S12b idle lanes — scaffold, SKIPPED on the shared server. Each lane needs a
// planted finding in the sample repo (test.skip, `as any`, README drift, a '*'
// dependency, a coverage script above/below the threshold, an eval hotspot) and
// GitHub/Jira ingest needs a fake `gh` on PATH, which would change what every other
// suite's idle Poll does. The golden path already drives the tech-debt lane end to
// end (regress.mjs §6c). This file is where an own-server shard adds the rest.
export const needsRepo = false;
export default async function s12b(t) {
  t.skip(
    "seven idle lanes + feature backlog + legacy IDLE_DRAFT: need planted findings and their own server (they would change every other suite's idle Poll)",
  );
  t.skip("GitHub / Jira issue ingest: needs its own server with a fake `gh` on PATH");
}
