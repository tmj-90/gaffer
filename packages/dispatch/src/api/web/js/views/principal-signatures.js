// SEALED PRINCIPALS: the Settings callout for sign-ins this factory does not honour.
//
// A principal is honoured only with a signature under the factory key. Rows created before
// signing existed (or restored from a backup, or written straight into the database) are
// refused like an unknown token until a PERSON reviews and re-signs them. Nothing is
// signed on upgrade. This module is self-contained: Settings mounts it with one line, and
// it renders nothing when every sign-in is signed.
//
// Re-signing is the operator's act (the shared token): the server refuses a principal's
// session (403), so such a session sees the list and no buttons. "Re-sign all" sends the
// fingerprint of the list shown here: a sign-in added or changed after it rendered is
// never signed by that click (the server refuses, and the list reloads). Each row shows
// who it acts as, what it may do, where (its scope), who created it and when, because a
// row written into the database can carry a forged creation event: only the person's
// review tells it apart.

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
      const fingerprint = res && typeof res.fingerprint === "string" ? res.fingerprint : "";
      host.appendChild(render(unsigned, fingerprint, canResign(whoami)));
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

function render(unsigned, fingerprint, manage) {
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
        "Until a person re-signs them they are refused like an unknown token. Check each one: re-sign only the sign-ins you created yourself, with the access shown; revoke the rest in Access below.",
      ),
      el(
        "ul",
        { class: "principal-signatures-list", "aria-label": "Unsigned sign-ins" },
        unsigned.map((u) => item(u, manage)),
      ),
      manage && recorded.length > 1 && fingerprint
        ? resignButton(
            `Re-sign the ${recorded.length} listed with a creation on record`,
            { all: true, confirm: fingerprint },
            "Re-signed",
          )
        : null,
    ]),
  ]);
  return box;
}

function scopeText(scope) {
  if (!scope) return "every repo and ticket";
  const parts = [];
  if (Array.isArray(scope.repos)) {
    parts.push(`repos ${scope.repos.map((r) => r.name ?? r.id).join(", ") || "none"}`);
  }
  if (Array.isArray(scope.tickets)) {
    parts.push(
      `tickets ${scope.tickets.map((t) => (t.number != null ? `#${t.number}` : t.id)).join(", ") || "none"}`,
    );
  }
  return parts.join("; ");
}

function item(u, manage) {
  const who = `${u.actor_type}:${u.actor_id}`;
  const facts =
    `${u.capability}, acts as ${who}, ${scopeText(u.scope)}` +
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
