// @vitest-environment jsdom
//
// DOM test for AFK-LOOP Phase 3 (mobile ergonomics): the Review gate's reject
// flow must let an operator reject ONE-HANDED on a phone — no keyboard, no
// `window.prompt` (a blocking-dialog footgun in automation). Rejecting opens a
// dialog with preset reason chips + a free-text fallback.
//
// The invariant under test (carried over from the prompt flow): a reject reason
// is REQUIRED. With no chip tapped and nothing typed the submit is inert and no
// reject request is sent (the negative control). Tapping a chip (or typing)
// makes submit fire the existing reject endpoint with the chosen reason.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Ship the thing",
  status: "in_review",
  risk_level: "low",
  branch_name: "feat/x",
  pr_url: null,
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

/** Stub the Review endpoints and record every mutating call so a test can assert
 *  whether (and with what body) the reject endpoint was hit. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      let payload: unknown = {};
      if (url.includes("/tickets/") && url.endsWith("/diff"))
        payload = {
          ticketId: TICKET.id,
          repos: [
            {
              repo: "svc",
              branch: "feat/x",
              baseBranch: "main",
              diff: "diff --git a/x b/x\n+real\n",
              files: 1,
              additions: 1,
              deletions: 0,
              truncated: false,
            },
          ],
        };
      else if (url.includes(`/tickets/${TICKET.id}/review/reject`)) payload = { ok: true };
      else if (url.includes(`/tickets/${TICKET.id}`))
        payload = { ...TICKET, acceptance_criteria: [], evidence: [], events: [] };
      else if (url.includes("/tickets")) payload = { tickets: [TICKET] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/review";
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function bootReview(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function rejectDialog(): HTMLElement | null {
  return document.querySelector(".reject-dialog");
}
function submitButton(): HTMLButtonElement | null {
  return document.querySelector(".reject-dialog-actions .btn.danger") as HTMLButtonElement | null;
}
function rejectCalls(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.url.includes("/review/reject"));
}

describe("web AFK P3: reject-reason chips replace window.prompt on the Review gate", () => {
  beforeEach(() => {
    calls = [];
    mountShell();
    vi.resetModules();
    stubFetch();
    // A stray window.prompt would silently mask a regression — fail loud if the
    // old blocking flow ever returns.
    vi.stubGlobal(
      "prompt",
      vi.fn(() => {
        throw new Error("window.prompt must not be used by the reject flow");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.querySelectorAll(".reject-scrim").forEach((n) => n.remove());
  });

  it("opens a chip dialog (not window.prompt) when rejecting to rework", async () => {
    await bootReview();
    const sendBack = buttonByText("Send back to rework");
    expect(sendBack, "the rework reject button should render").toBeDefined();

    sendBack!.click();
    const dialog = rejectDialog();
    expect(dialog, "a reject dialog should open").not.toBeNull();
    // Preset chips render as tappable buttons + a free-text fallback exists.
    expect(dialog!.querySelectorAll(".reject-chip").length).toBeGreaterThan(0);
    expect(dialog!.querySelector(".reject-reason-input")).not.toBeNull();
  });

  it("NEGATIVE CONTROL: no chip + no text ⇒ submit is inert, no reject sent", async () => {
    await bootReview();
    buttonByText("Send back to rework")!.click();

    const submit = submitButton();
    expect(submit, "the dialog submit should render").not.toBeNull();
    // Held disabled while the reason is empty — the required invariant.
    expect(submit!.hasAttribute("disabled")).toBe(true);

    // Even forcing the click must not POST a reject (backstop the invariant).
    submit!.click();
    await tick();
    expect(rejectCalls()).toHaveLength(0);
  });

  it("tapping a preset chip submits the reject with that reason", async () => {
    await bootReview();
    buttonByText("Send back to rework")!.click();

    const chip = document.querySelector(".reject-chip") as HTMLButtonElement;
    const chipText = chip.textContent!.trim();
    chip.click();

    const submit = submitButton()!;
    expect(submit.hasAttribute("disabled"), "chip selection enables submit").toBe(false);
    submit.click();
    await tick();

    const sent = rejectCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain(`/tickets/${TICKET.id}/review/reject`);
    expect(sent[0]!.body).toMatchObject({ to: "refining", reason: chipText });
    // Dialog closes after a successful reject.
    expect(rejectDialog()).toBeNull();
  });

  it("typing a free-text reason (no chip) also submits", async () => {
    await bootReview();
    buttonByText("Won't do")!.click();

    const input = document.querySelector(".reject-reason-input") as HTMLInputElement;
    input.value = "Superseded by a newer ticket";
    input.dispatchEvent(new Event("input"));

    const submit = submitButton()!;
    expect(submit.hasAttribute("disabled")).toBe(false);
    submit.click();
    await tick();

    const sent = rejectCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      to: "cancelled",
      reason: "Superseded by a newer ticket",
    });
  });
});
