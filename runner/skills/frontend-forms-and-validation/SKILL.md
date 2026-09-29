---
name: frontend-forms-and-validation
description: Use when a ticket builds or changes a form — inputs, validation, error display, submission, multi-step flows, file fields — and it must validate with the same schema the server uses, be fully keyboard- and screen-reader-usable, and handle every state (pristine, invalid, submitting, failed, succeeded) without losing the user's work or submitting twice. Invoke for "add a form for X", "validation is inconsistent", "the error isn't shown", or "the form clears on error".
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Build a form that validates, explains and never loses input

A form is a contract with the server. Share the rules so client and server never
disagree, tell the user what is wrong in text next to the field, keep every keystroke
through errors and navigation, and make exactly one submission per intent. WCAG 2.2 AA
criteria that apply directly: 1.3.1, 1.3.5 (autocomplete), 3.3.1, 3.3.2, 3.3.3, 3.3.4,
3.3.7 (redundant entry) and 3.3.8 (accessible authentication).

## Steps

1. **Use the repo's form stack.** The form library (React Hook Form, TanStack Form,
   Formik, framework form actions, React 19 `useActionState`/`useFormStatus`), the schema
   library (Zod, Valibot, Yup) and the shared input components. Call `search_lore`; never
   add a second form or schema library.
2. **One schema, both sides.** Import or generate the schema the API validates with. The
   client validates for speed; the server validates for truth (the
   `security-input-validation` skill). Map the server's field errors (for example an RFC
   9457 problem body with per-field `errors`) back onto the fields, and show form-level
   errors in the summary — never only in a toast.
3. **Markup that assistive tech understands.**
   - Visible `<label for>` on every control; placeholder is an example, never the label.
   - Groups of radios/checkboxes in `fieldset` + `legend`.
   - Required marked in text ("required" or a legend explaining `*`) plus the `required`
     attribute.
   - Help and error text linked by `aria-describedby`; `aria-invalid="true"` only after the
     field has been validated and failed.
   - `autocomplete` tokens on personal data (`name`, `email`, `tel`, `street-address`,
     `postal-code`, `cc-number`, `one-time-code`, `new-password`,
     `current-password`) — required by 1.3.5 and it makes password managers work.
   - The right `type`/`inputmode`/`enterkeyhint` (`type="email"`, `inputmode="numeric"`
     for codes, not `type="number"` for things that are not quantities).
4. **Validate at the right moment.** On blur for a field the user has left; on change
   once a field is showing an error (so it clears as they fix it); everything on submit.
   Never on the first keystroke. Async checks (username taken) are debounced and
   cancellable.
5. **On a failed submit:** keep all input, show an error summary at the top with links to
   each field (the GOV.UK pattern), move focus to the summary (or to the only invalid
   field in short forms), and phrase each message as the fix: "Enter a date in the past",
   not "Invalid".
6. **Submit exactly once.** While the request is pending: a visible pending state on the
   button, repeated activations ignored, the request carries an idempotency key when the
   API supports one (the `idempotency-and-retries` skill). Prefer ignoring re-clicks (or
   `aria-disabled`) over disabling the button before submission — a disabled submit hides
   why the form cannot be sent. After success: confirmation, then navigate or reset as the
   AC says. A failed submit that clears the form is a bug.
7. **Editing existing records.** Load the current value with its version/`ETag`; submit
   it back. On `409`/`412` keep the user's edits and explain the record changed — do not
   silently overwrite another user's save (the `frontend-data-fetching` skill).
8. **Preserve work.** Multi-step flows keep earlier answers when the user goes back, and
   never ask for the same information twice (3.3.7). Long forms keep a draft (per the
   `frontend-state-management` skill) and warn before leaving with unsaved changes.
9. **Hard inputs.** Dates: native `input type="date"` or the design-system picker, stored
   as ISO 8601, displayed per locale (the `i18n-l10n` skill). Money: integer minor units
   plus currency code. Phone/postcode: lenient parsing, strict validation. Passwords and
   codes: allow paste and password managers, offer show-password, no cognitive-test
   CAPTCHA (3.3.8). Files: the `file-uploads` skill.
10. **Test per AC** (the `frontend-testing` skill), with `userEvent` and the network
    mocked:
    - a valid submit sends the expected payload once and shows success;
    - each rule the AC names shows its message, linked to the field
      (`toHaveAccessibleDescription`), and `aria-invalid` is set;
    - a server field error lands on the field; a 500 keeps all input and allows retry;
    - double click / Enter twice → one request;
    - the whole form is completable by keyboard, with fields found by label.
    Evidence each AC with the `record-evidence` skill, then stop.

## Done when

Each AC has a test that drives the form as a user would and asserts the visible outcome;
client and server share one schema; no path loses input or submits twice; axe reports no
violations on the pristine and error states (or the evidence says the repo has no axe
tooling).

## Anti-patterns

- Validation rules written twice by hand (client regex drifts from the server).
- Errors in red only, in a toast only, or announced before the user has finished typing.
- `type="number"` for card numbers, postcodes or IDs; blocking paste into password fields.
- `onSubmit` without `preventDefault` handling or without a pending guard.
- Resetting the form in a `finally` block (clears it on failure too).

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While sharing the schema you learn where the validation schemas live, which form library is in use and how field errors are displayed.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
