---
name: i18n-l10n
description: Use when a ticket adds user-facing text or must support more than one language, locale, or region — translations, plurals, dates and numbers, currencies, right-to-left layout, time zones — and the implementation must externalise every string, format by locale with the platform's APIs, and never concatenate sentences. Invoke for "add German", "translate the new screen", "the date shows in the wrong format", or whenever you type a user-visible string.
stack: [react, web, next, vue, svelte, angular, node, python, java, kotlin, swift, csharp]
area: frontend
---

# Internationalise and localise correctly

A hard-coded string is a bug that appears the day a second locale ships. Externalise
every user-visible string with a stable key and an ICU-style message, format dates,
numbers and currencies with the locale APIs, design layouts that survive longer words and
right-to-left, and keep the source-language file as the single place text is written.

## Steps

1. **Use the repo's i18n framework.** The library (i18next, FormatJS/react-intl,
   vue-i18n, Angular i18n, gettext, ICU MessageFormat on the server), the message-file
   layout, the key naming scheme, and how locale is detected and persisted. Call
   `search_lore`. Never add a second mechanism or a parallel strings file.
2. **Externalise every string.** Each user-visible string gets a stable, namespaced key
   and a source-language message; no string literals in components, error messages the
   user sees, emails, or validation messages. Keys describe meaning
   (`ticket.actions.approve`), not the English text.
3. **Write messages that translators can translate.** Whole sentences with named
   placeholders (`{count} tickets ready`), never concatenated fragments or values
   inserted by position; plurals and genders through ICU `plural`/`select`, never
   `count + " item(s)"`; no HTML inside messages unless the framework supports rich
   text tags.
4. **Format by locale with the platform.** `Intl.DateTimeFormat`, `Intl.NumberFormat`,
   `Intl.RelativeTimeFormat`, `Intl.ListFormat` (or the language's equivalents); currency
   with the currency code, never a hard-coded symbol; store times in UTC and render in
   the user's time zone; sort with `Intl.Collator`.
5. **Design for expansion and direction.** Layouts tolerate 30–50% longer strings
   (German, Finnish) and shorter ones (Chinese) without truncation or overflow; use
   logical CSS properties (`margin-inline-start`) and `dir="rtl"` support where the
   repo targets RTL locales; icons with direction (arrows) flip.
6. **Keep the source file honest.** Add new keys to the source-language file in the
   same change; run the repo's extraction/lint for missing or unused keys; never ship a
   key without its source message. Translations arrive through the repo's translation
   workflow; a missing translation falls back to the source language visibly in
   development.
7. **Test** with a pseudo-locale or a second real locale: every new string renders from
   its key (no untranslated literals), plurals switch correctly at 0/1/many, dates and
   numbers format per locale, layout holds with expanded text, RTL mirrors where
   supported. Evidence with the `record-evidence` skill.

## Rules

- No user-visible string literal in code; every string has a namespaced key and a
  source message.
- Whole-sentence messages with named placeholders; ICU plural/select; no concatenation.
- Dates, numbers, currencies, lists and sorting via the locale APIs; UTC stored.
- Layout tolerates expansion and direction; logical properties over left/right.
- Extraction/lint clean; source file updated in the same change.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While externalising strings you learn the i18n framework, the key scheme, how locale is detected and how far RTL support goes.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
