#!/usr/bin/env node
// Canned stand-in for runner/bin/research-run.mjs (GAFFER_RESEARCH_BIN, set by the
// s26-research suite's own server): the same stdin/stdout contract, no model call, no
// network. Calls are appended to $GAFFER_DATA/research-calls.jsonl.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const req = JSON.parse(readFileSync(0, "utf8") || "{}");
try {
  if (process.env.GAFFER_DATA)
    appendFileSync(
      path.join(process.env.GAFFER_DATA, "research-calls.jsonl"),
      JSON.stringify(req) + "\n",
    );
} catch {
  /* best-effort */
}
setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      phase: "research",
      result: {
        summary: "Several task apps archive instead of deleting; people want undo and a filter.",
        findings: [
          {
            id: "f1",
            claim: "Todoist and Things keep completed tasks in an archive.",
            why: "Users expect to find old tasks.",
            sources: [{ url: "https://todoist.com/help/articles/view-completed-tasks" }],
          },
          {
            id: "f2",
            claim: "People complain when completed tasks vanish.",
            why: "Lost history.",
            sources: [
              { url: "https://www.reddit.com/r/productivity/comments/abc/completed_tasks/" },
            ],
          },
          { id: "f3", claim: "An archive needs a search to stay useful.", why: "", sources: [] },
          // A hostile finding (review of backlog 69): markup, a Markdown image and link,
          // an inline handler and unsafe sources. It must render as inert text, and the
          // page must never request anything it names.
          {
            id: "f4",
            claim:
              '<img src="https://img.hostile-research.dev/p.png" onerror="window.__pwned=1"> ![x](https://img.hostile-research.dev/m.png)',
            why: "[pricing](javascript:window.__pwned=2) <script>window.__pwned=3</script>",
            sources: [
              { url: "http://todoist.com/plain" },
              { url: "https://user:pw@todoist.com/" },
              { url: "javascript:window.__pwned=4" },
              { url: "https://hostile-research.dev/article" },
            ],
          },
        ],
        comparables: [
          {
            name: "Todoist",
            note: "Completed tasks view",
            source: { url: "https://todoist.com/" },
          },
        ],
        features: [
          {
            id: "x1",
            title: "Archive completed tasks",
            description: "Completed tasks move to an archive instead of being deleted.",
            priority: "must",
            backed_by: ["f1"],
          },
          {
            id: "x2",
            title: "Undo an archive",
            description: "Bring an archived task back.",
            priority: "should",
            backed_by: ["f2"],
          },
          {
            id: "x3",
            title: "Search the archive",
            description: "Find an archived task by text.",
            priority: "could",
            backed_by: ["f3"],
          },
          {
            id: "x4",
            title: "Archive sync to the cloud",
            description: "",
            priority: "wont",
            backed_by: [],
          },
        ],
        open_questions: [
          { id: "q1", text: "Archive automatically after some days, or only by hand?" },
        ],
        risks: [{ id: "k1", text: "A large archive slows the list" }],
        dropped_urls: 0,
      },
      log: {
        fetches: [
          {
            url: "https://todoist.com/help/articles/view-completed-tasks",
            host: "todoist.com",
            ts: new Date().toISOString(),
          },
        ],
        searches: [{ query: "archive completed tasks app", ts: new Date().toISOString() }],
      },
    }) + "\n",
  );
}, 1500);
