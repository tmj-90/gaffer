---
name: i18n-l10n
description: Use when a ticket adds user-facing text or must support more than one language, locale, or region — translations, plurals, dates and numbers, currencies, right-to-left layout, time zones — and the implementation must externalise every string, use ICU/CLDR plural rules, format by locale with the platform's APIs, and never concatenate sentences. Invoke for "add German", "translate the new screen", "the date shows in the wrong format", or whenever you type a user-visible string.
stack: [react, web, next, vue, svelte, angular, node, python, java, kotlin, swift, csharp]
area: frontend
---

# Internationalise and localise correctly

A hard-coded string or a hand-built plural is a bug that surfaces the day a second locale
ships. Externalise every user-visible string as a whole message with named arguments,
let CLDR data (through ICU MessageFormat and the `Intl` APIs or the language's
equivalents) decide plurals and formats, and build layouts that survive longer text and
right-to-left scripts.

## Steps

1. **Use the repo's mechanism.** Library (i18next, FormatJS/react-intl, vue-i18n,
   Angular i18n, Lingui, gettext, ICU4J/ICU4X, .NET resources, Apple String Catalogs,
   Android resources), message file layout, key scheme, locale detection and persistence.
   Call `search_lore`. Never add a second mechanism or a parallel strings file.
2. **Externalise every string** users can see or hear: labels, placeholders, `alt` and
   `aria-label` text, validation and error messages, emails, notifications, page titles.
   Keys describe meaning and location (`ticket.actions.approve`), never the English text.
   APIs return error **codes** and parameters; the client localises them.
3. **Write translatable messages.**
   - Whole sentences with named arguments: `{name} approved {count, plural, one {# ticket}
     other {# tickets}}` — never `"Approved " + n + " ticket(s)"`.
   - Plurals use CLDR categories (`zero`, `one`, `two`, `few`, `many`, `other`). English
     uses only `one`/`other`, but Polish needs `few`/`many` and Arabic all six, so never
     branch on `n === 1` in code. `other` is always present. `=0 {No tickets}` is an exact
     match, distinct from the `zero` category.
   - Ordinals use `selectordinal` ("1st, 2nd"); gendered text uses `select`.
   - Rich text uses the library's tag syntax (`<b>{name}</b>`), not HTML concatenation.
   - Give translators a description for ambiguous short strings ("Open" verb or
     adjective?).
   - Unicode MessageFormat 2 is stable in CLDR 47, but most libraries still use ICU
     MessageFormat 1 syntax; write what the repo's library parses.
4. **Format with the locale APIs.** `Intl.DateTimeFormat` (prefer `dateStyle`/`timeStyle`
   over pattern strings), `Intl.NumberFormat` (including `style: 'currency'` with an ISO
   4217 code, `'percent'`, `'unit'`, `notation: 'compact'`), `Intl.RelativeTimeFormat`,
   `Intl.ListFormat`, `Intl.PluralRules`, `Intl.Collator` for sorting,
   `Intl.Segmenter` for truncating text by grapheme or word, `Intl.DisplayNames` for
   language/region names. Reuse formatter instances; they are costly to construct.
5. **Money and time.** Money is integer minor units plus the currency code; minor units
   vary (JPY 0, USD 2, KWD 3) — take them from the formatter or ISO 4217, not a constant
   100. Past instants are stored as UTC and displayed in the user's IANA time zone
   (`Europe/Berlin`, not "CET" or an offset). A future local event (a 09:00 meeting) is
   stored as local date-time plus IANA zone, so a DST rule change does not move it. Use
   `Temporal` where the runtime supports it, else the repo's date library; never parse
   locale-formatted strings back into dates.
6. **Locale selection.** BCP 47 tags (`pt-BR`, `zh-Hant-TW`); negotiate from the user's
   saved preference, then `Accept-Language`/`navigator.languages`, then the default; fall
   back through the chain (`de-AT` → `de` → default). Never infer language from IP or
   country. Set `<html lang>` and `dir`, and `lang` on inline passages in another
   language (WCAG 3.1.1, 3.1.2).
7. **Layout for expansion and direction.** Allow roughly 30–40% longer text (more for
   short labels) without clipping; no fixed-width buttons around text. Use CSS logical
   properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`) and
   flex/grid, which mirror automatically under `dir="rtl"`. Mirror directional icons
   (back/forward arrows), not universal ones (play, checkmark, logos). Isolate
   user-generated text inside messages (`<bdi>` or the library's bidi isolation) so an
   Arabic name does not reorder the sentence.
8. **Keep the catalogue honest.** Add new keys to the source-locale file in the same
   change; run the repo's extraction and missing/unused-key check; remove keys you
   orphaned. Translations arrive through the repo's workflow — do not machine-translate
   into production catalogues unless the ticket says to.
9. **Test** (the `frontend-testing` skill), per AC:
   - render under a pseudo-locale (accented, ~40% longer, bracketed: `[Ţîçķéţš ~~]`) or a
     long real locale (de, fi) → no raw keys, no untranslated literals, no clipping;
   - plurals at 0, 1, 2, 5, 21 and 22 in a locale with `few`/`many` (pl or ru);
   - dates, numbers and currency snapshot for two locales and a non-UTC time zone
     (set `TZ` in the test run);
   - `dir="rtl"` renders mirrored where the repo supports RTL.
   Record per-AC evidence with the `record-evidence` skill, then stop.

## Done when

No user-visible literal remains in the changed code; every new key exists in the source
catalogue and the extraction check is clean; plural, date, number and currency output is
produced by CLDR-backed APIs and tested in at least two locales.

## Anti-patterns

- String concatenation or template literals building sentences; `n === 1 ? '' : 's'`.
- Hard-coded `$`, `,` or `.` separators; `toFixed(2)` for money; `MM/DD/YYYY` patterns.
- Storing local wall-clock times without a zone; using fixed offsets for zones.
- `margin-left` for spacing that should follow text direction; flipping every icon.
- Keys named after the English text; one giant catalogue key reused in two meanings.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While externalising strings you learn the i18n framework, the key scheme, how locale is detected and how far RTL support goes.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
