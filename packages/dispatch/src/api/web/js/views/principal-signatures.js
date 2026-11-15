// SEALED PRINCIPALS: the Settings callout for sign-ins this factory does not honour.
//
// A principal is honoured only with a signature under the factory key. Rows created before
// signing existed (or restored from a backup, or written straight into the database) are
// refused like an unknown token until a PERSON reviews and re-signs them. Nothing is
// signed on upgrade. This module is self-contained: Settings mounts it with one line, and
// it renders nothing when every sign-in is signed.
//
// Re-signing is the operator's act (the shared token): the server refuses a principal's
// session (403), so such a session sees the list and no buttons.

import { api } from "../api.js";
import { el } from "../dom.js";
import { icon } from "../icons.js";
import { router } from "../router.js";
import { runAsyncAction, toast } from "../toast.js";

/**
 * The callout element (empty until the list loads; hidden when there is nothing to show).
 * `whoami` (GET /api/whoami) decides whether this session may re-sign.
 */
export function principalSignaturesCallout(whoami) {
  const host = el("div", {
    class: "principal-signatures",
    id: "principal-signatures",
    hidden: "",
  });
  api("GET", "/api/principal-signatures")
    .then((res) => {
      const unsigned = res && Array.isArray(res.unsigned) ? res.unsigned : [];
      if (unsigned.length === 0) return;
      host.appendChild(render(unsigned, canResign(whoami)));
      host.hidden = false;
    })
    .catch(() => {
      // Best-effort: the list must never blank the Settings page.
    });
  return host;
}

function canResign(whoami) {
  const cap = whoami && whoami.capability ? whoami.capability : "full";
  return cap === "full" && !(whoami && whoami.principal);
}

function render(unsigned, manage) {
  const n = unsigned.length;
  const recorded = unsigned.filter((u) => u.creation_event);
  const box = el("div", { class: "warn-box", role: "note", "data-testid": "unsigned-principals" }, [
    icon("alert"),
    el("div", {}, [
      el(
        "strong",
        {},
        `${n} sign-in${n === 1 ? " was" : "s were"} created before signing. Review and re-sign.`,
      ),
      el(
        "p",
        {},
        "Until a person re-signs them they are refused like an unknown token. Re-sign only the ones you recognise; revoke the rest in Access below.",
      ),
      el(
        "ul",
        { class: "principal-signatures-list", "aria-label": "Unsigned sign-ins" },
        unsigned.map((u) => item(u, manage)),
      ),
      manage && recorded.length > 1
        ? resignButton(
            `Re-sign all ${recorded.length} with a creation on record`,
            { all: true },
            "Re-signed",
          )
        : null,
    ]),
  ]);
  return box;
}

function item(u, manage) {
  const who = `${u.actor_type}:${u.actor_id}`;
  const facts =
    `${u.capability}, acts as ${who}${u.scoped ? ", scoped" : ""}` +
    ` · created ${String(u.created_at || "").slice(0, 10)}${u.created_by ? ` by ${u.created_by}` : ""}`;
  const warn = u.creation_event
    ? null
    : el(
        "span",
        { class: "principal-signatures-nocreate" },
        " · no creation on record: if you did not create it, revoke it",
      );
  return el("li", { "data-principal": u.name }, [
    el("strong", {}, u.name),
    ` (${facts})`,
    warn,
    manage ? resignButton("Re-sign", { names: [u.id] }, `Re-signed “${u.name}”`) : null,
  ]);
}

function resignButton(label, body, done) {
  const btn = el("button", { class: "btn small ghost", type: "button" }, el("span", {}, label));
  btn.addEventListener("click", () => {
    runAsyncAction(btn, "Re-signing…", async () => {
      const res = await api("POST", "/api/principal-signatures/resign", body);
      const skipped = res && Array.isArray(res.skipped) ? res.skipped.length : 0;
      toast(`${done}.${skipped ? ` ${skipped} left for you to review.` : ""}`, { ok: true });
      router();
    });
  });
  return btn;
}
