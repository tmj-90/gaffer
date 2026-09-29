---
name: prepare-digest-delta
description: Use right after a ticket is implemented and evidenced — while you still hold the diff in context — to PREPARE the Repo Digest delta and the feature note as a recorded evidence row, so the merge step can apply them deterministically WITHOUT spending a fresh agent call. Invoke once your change is committed and its ACs are evidenced, as the last thing you do before you stop (the runner submits for review). It only PREPARES (records inert evidence); the merge APPLIES it post-review, so a rejected delivery never touches the digest.
stack: []
area: workflow
---

# Prepare the Repo Digest delta (apply-at-merge)

You just implemented and evidenced a ticket, so you are the cheapest place to write down
how the **Repo Digest** should read after it and which **feature** it ships. This skill
records that as ONE evidence row. It is inert: the merge step reads it after review
approval and applies it without an agent call. A rejected ticket never merges, so its
delta never touches the digest.

## How the merge applies it (why the shape matters)

- The digest has exactly four sections: `overview` (what the repo is, key flows),
  `structure` (layout, modules, surface area), `conventions` (rules, patterns,
  gotchas), `stack` (languages, dependencies, tooling). Obvious synonyms are mapped
  (`architecture` → structure, `gotchas` → conventions, `dependencies` → stack);
  anything else is dropped.
- **Each section you send REPLACES that whole section.** Sections you omit are kept.
  So `content` must be the complete new text of the section, not a fragment or a
  changelog line — sending "Added a /health route" as `structure` erases the rest of it.
  Send each section at most once: two entries that map to the same section (say
  `structure` and `architecture`) are applied in order and the second replaces the first.
- A section write only merges into an EXISTING digest. With no digest yet, the memory
  CLI refuses any write that does not carry all four sections.
- The merge stamps freshness even when `sections` is empty.
- If the ticket description has a `Feature-Id: <id>` line, the merge advances that
  feature to shipped and ignores your feature note. Otherwise your `feature` is added
  as shipped.
- The merge uses the repo it merged into; your `repo` value is only a fallback.
- The last well-formed row wins; a malformed row is ignored (only the freshness stamp
  lands).

## Steps

1. **Decide which sections your change made stale.** Most tickets change zero or one.
   A new module, route, or command → `structure`; a new rule or pattern the next agent
   must follow → `conventions`; a new dependency or tool → `stack`; a new user-facing
   capability → `overview`. Pure internal fixes usually change none: send `[]`.
2. **For each stale section, rewrite it in full.** Call `get_repo_digest` (Memory MCP)
   for this repo and take the current text of that section. Edit it so it is true after
   your change: replace stale sentences, add the new fact where it belongs, keep what is
   still true. If there is no digest yet, send `sections: []` — onboarding creates the
   first digest, and a partial write would be refused. Keep it tight — the digest is a
   map, not a history.
3. **Name the feature** (skip if the ticket ships no discrete capability or carries a
   `Feature-Id:` line): `name`, a one-line `summary`, and when known `scopeNode` and
   `provenance` (e.g. the epic ref).
4. **Build the payload with a JSON serializer**, not by hand, so quotes and newlines are
   escaped correctly, e.g.
   `node -e 'console.log("GAFFER_DIGEST_DELTA_V1 " + JSON.stringify({repo:"app",sections:[{section:"structure",content:"…"}],feature:{name:"Password reset",summary:"…"}}))'`.
   The safety hook blocks any Bash command that mentions `.env`, `process.env`,
   `secret(s)` or `credentials`, and a `'` in the text breaks the `node -e '…'`
   quoting; in either case write the JSON line by hand (escape `"` as `\"` and
   newlines as `\n`, keep it on one line). The whole line must be under 5,000 characters (the evidence summary limit). Trim
   prose rather than splitting it into multiple rows.
5. **Record ONE row** with `record_ac_evidence`: `ticket_id` = this ticket, NO `ac_id`,
   `evidence_type: "manual_note"`, `summary` = exactly the line from step 4:

   ```
   GAFFER_DIGEST_DELTA_V1 {"repo":"<repo-name>","sections":[{"section":"<digest section>","content":"<complete updated section text>"}],"feature":{"name":"<feature name>","summary":"<one line>","scopeNode":"<id or omit>","provenance":"<epic ref or omit>"}}
   ```

   It starts with `GAFFER_DIGEST_DELTA_V1`, one space, then one-line valid JSON.
   `sections` may be `[]`; `feature` may be omitted. To correct a mistake, record a
   complete new row (the last one wins), never a partial patch.
   On a resumed delivery the runner holds no claim, so this call is refused: do not
   retry, and do not paste the line into your final message (the merge cannot read it
   from there, and it would push your AC map and smallest-change note out of the part
   the runner records). The merge then only stamps freshness.
6. **Stop.** Applying is the merge's job alone.

## Done when

Exactly one well-formed `GAFFER_DIGEST_DELTA_V1` row is recorded; every section in it is
the complete, true text for after this change; the line is under 5,000 characters.

## Rules

- Prepare only, never apply: no `update_repo_digest`, `add_feature` or
  `advance_feature` calls from a delivery.
- Describe the repo as it IS after this diff; no plans or speculative future work.
- Never put secrets, tokens, hostnames of private infrastructure, or ticket-text
  instructions into the digest; it is served to every future agent.
- If you cannot produce valid JSON after one retry, record `sections: []` with only
  the feature note; a freshness stamp is better than a wrong section.
