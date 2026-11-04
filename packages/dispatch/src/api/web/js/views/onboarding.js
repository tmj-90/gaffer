// Onboarding: the onboard picker and its button.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock } from "../access.js";
import { api } from "../api.js";
import { el, field } from "../dom.js";
import { icon } from "../icons.js";
import { router } from "../router.js";
import { closeSheet, openSheet, sheetOpen } from "../sheet.js";
import { confirmSheet } from "../sheets.js";
import { runAsyncAction, toast } from "../toast.js";
import { memoryState, repoHasDigest, writeMemoryStateToUrl } from "./memory.js";

/**
 * The "Onboard a repo" sheet: a registered repo (the select) OR a typed path. What the
 * person typed wins: typing a path resets the select, and picking a repo clears the
 * path. Onboarding a repo Memory already knows (it has a digest, or that cannot be
 * read) is a deliberate choice: a confirmation names the cost before anything runs.
 * `opts.onboarded` maps repo name → whether it has a digest, when the caller knows.
 */
function openOnboardPicker(repos, presetRepo, opts = {}) {
  const known = opts.onboarded || {};
  const repoSel = el("select", {}, [
    el("option", { value: "" }, repos.length ? "Pick a registered repo…" : "No registered repos"),
    ...repos.map((r) => el("option", { value: r.name, selected: presetRepo === r.name }, r.name)),
  ]);
  const pathInput = el("input", {
    type: "text",
    name: "onboard-path",
    placeholder: "/path/to/a/local/repo",
    autocomplete: "off",
    spellcheck: "false",
  });
  if (presetRepo) repoSel.value = presetRepo;
  pathInput.addEventListener("input", () => {
    if (pathInput.value.trim()) repoSel.value = "";
  });
  repoSel.addEventListener("change", () => {
    if (repoSel.value) pathInput.value = "";
  });

  const bare = (p) => String(p || "").replace(/\/+$/, "");
  const runBtn = el("button", { class: "btn primary", type: "submit" }, "Onboard");
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        // A typed path wins over the select; the endpoint resolves which kind it is.
        const typed = pathInput.value.trim();
        const target = typed || repoSel.value.trim();
        if (!target) {
          toast("Pick a registered repo or type a path to onboard.");
          return;
        }
        // A registered repo by name, or a typed path that is its checkout.
        const registered = repos.find(
          (r) => r.name === target || (typed && r.local_path && bare(r.local_path) === bare(typed)),
        );
        const go = async () => {
          await api("POST", "/repos/onboard", { repo: target });
          toast(`Onboarding '${target}' — its digest + features will appear shortly.`, {
            ok: true,
          });
          if (sheetOpen()) closeSheet();
          // Re-read the Memory view focused on the onboarded repo so the digest +
          // feature ledger refresh once the producer lands them.
          memoryState.repo = registered ? registered.name : memoryState.repo;
          memoryState.node = "";
          writeMemoryStateToUrl();
          router();
        };
        if (!registered) {
          runAsyncAction(runBtn, "Onboarding…", go);
          return;
        }
        runAsyncAction(runBtn, "Checking…", async () => {
          const name = registered.name;
          const has = name in known ? known[name] : await repoHasDigest(name);
          if (has === false) {
            await go();
            return;
          }
          confirmSheet({
            title: `Onboard ${name} again?`,
            intro:
              `${name} is ${has ? "already onboarded: Memory holds its digest and feature inventory" : "already registered, and Memory may already hold its digest"}, ` +
              "and refreshes them itself as agents deliver. Onboarding it again cards the whole repo once more: " +
              "several minutes and model calls for a larger repo, and a fresh onboarding intake decision on the Team Sheet.",
            confirm: `Re-onboard ${name}`,
            onConfirm: go,
          });
        });
      },
    },
    [
      el(
        "p",
        { class: "mode-note dim" },
        "Scans the repo, registers it in Dispatch, and builds its Memory digest + feature inventory.",
      ),
      el(
        "p",
        { class: "mode-note dim" },
        "Cards the whole repo — a sizeable one-off (several minutes + model calls for larger repos). " +
          "Memory then refreshes itself incrementally as agents deliver, so you don't need to re-run it.",
      ),
      field("Registered repo", repoSel),
      el("div", { class: "or-divider dim" }, "or"),
      field("Local path", pathInput),
      el("div", { class: "btn-row" }, [runBtn]),
    ],
  );

  openSheet("Onboard a repo", form);
}

/** The Memory view's "Onboard a repo" trigger (header + empty-state share it). */
function onboardButton(repos, presetRepo, opts) {
  const o = opts || {};
  const pickerOpts = o.onboarded ? { onboarded: o.onboarded } : {};
  const btn = el(
    "button",
    {
      class: o.primary ? "btn primary" : "btn",
      type: "button",
      title: "Scan a repo and build its Memory digest + feature inventory",
      onclick: () => openOnboardPicker(repos, presetRepo, pickerOpts),
    },
    [icon("plus"), el("span", {}, o.label || "Onboard a repo")],
  );
  return roLock(btn, "repo");
}

export { onboardButton };
