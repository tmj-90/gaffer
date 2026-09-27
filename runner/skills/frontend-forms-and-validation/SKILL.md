---
name: frontend-forms-and-validation
description: Use when a ticket builds or changes a form — inputs, validation, error display, submission, multi-step flows, file fields — and it must validate with the same schema the server uses, be fully keyboard- and screen-reader-usable, and handle every state (pristine, invalid, submitting, failed, succeeded) without losing the user's work. Invoke for "add a form for X", "validation is inconsistent", "the error isn't shown", or "the form clears on error".
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Build a form that validates, explains and never loses input

A form is a conversation with rules. Share the rules with the server so client and server
never disagree, tell the user exactly what is wrong next to where it is wrong, keep every
keystroke safe across errors and navigation, and make the whole thing work without a
mouse.

## Steps

1. **Use the repo's form stack.** The form library (React Hook Form, Formik, the
   framework's form actions), the schema library (Zod, Yup, Valibot), and the shared
   input components. Call `search_lore` for conventions; do not add a second form or
   schema library.
2. **Share the schema with the server.** Import (or generate from) the same validation
   schema the API uses so the rules are identical; validate on the client for immediate
   feedback and always again on the server (the `security-input-validation` skill); map
   server-side field errors back onto the fields, never only into a toast.
3. **Label everything.** Every control has a visible `<label>` associated by `for`/`id`
   (or the component's equivalent), required fields are marked in text not colour, help
   text is linked with `aria-describedby`, and the error message is linked to its field
   and announced (`aria-invalid`, `aria-live` on the summary). See the `frontend-a11y`
   skill.
4. **Validate at the right moment.** On blur for a field the user has left, on change
   once a field has been marked invalid, on submit for everything; never on first
   keystroke. Focus the first invalid field on a failed submit and show a summary at the
   top for long forms.
5. **Handle all the states explicitly.** Pristine, dirty, validating (async checks like
   username availability, debounced), submitting (button disabled, spinner, no double
   submit), failed (server error shown, input preserved, retry possible), succeeded
   (clear confirmation, navigation or reset as the ticket says). A failed submit that
   clears the form is a bug.
6. **Preserve work.** Draft state survives navigation away and back where the repo has
   the pattern (URL or session storage, per the `frontend-state-management` skill); warn
   before leaving with unsaved changes when the form is long.
7. **Handle the hard inputs.** Dates with a real date input or the repo's picker and an
   unambiguous format; money as integers in the smallest unit; phone and postcode with
   lenient parsing and strict validation; file fields per the `file-uploads` skill;
   selects with search when the option list is long.
8. **Test**: valid submit, each validation rule with its message, server error mapped to
   the field, double-submit prevented, keyboard-only completion, screen-reader labels
   present (the `frontend-testing` skill). Evidence with the `record-evidence` skill.

## Rules

- One form library, one schema library — the repo's; the schema is shared with the
  server and enforced on both sides.
- Every control labelled; errors linked and announced; required marked in text.
- Validate on blur/submit, not first keystroke; focus the first error.
- Submitting disables resubmission; failure preserves input; success confirms.
- No custom components for native controls that already work (dates, selects) unless
  the repo's design system provides them.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While sharing the schema you learn where the validation schemas live, which form library is in use and how field errors are displayed.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
