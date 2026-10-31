// S17 conflict re-review — scaffold, SKIPPED. Two deliveries that edit the same line
// of src/tasks.js (stub mode `conflict`), the first merged, the second's Merge now
// hits the conflict, a resolver reopens it for review with fresh DoD evidence. It
// needs a server with a resolver stub wired and the gate-integrity package's
// re-gating, and it asserts on Review's conflict banner, which is HELD. The seeds are
// here so the follow-up only has to add the steps.
export const needsRepo = false;
export const seeds = [
  { title: "Conflict A", mode: "conflict" },
  { title: "Conflict B", mode: "conflict" },
];
export default async function s17(t) {
  t.skip(
    "conflict re-review needs its own server (resolver stub) and asserts on Review's conflict banner, HELD for gate-integrity",
  );
}
