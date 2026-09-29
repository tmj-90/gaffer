---
name: file-uploads
description: Use when a ticket lets users send files — avatars, documents, CSV imports, attachments — or serves them back, and the path must be safe against oversized, malicious, or mis-typed content, store files outside the web root or in object storage, and never trust the client's filename or content type. Invoke for "let users upload X", "add an import", "serve the attachment", or any multipart or presigned-URL work.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Handle file uploads and downloads safely

An upload is untrusted input that is large, binary, and often stored for years. Limit it
before you read it, verify what it really is, write it under a name you chose, atomically,
in a place that cannot execute, and serve it back with headers that stop the browser
guessing. Source: OWASP File Upload Cheat Sheet; OWASP ASVS 5 V5 (file handling).

## Steps

1. **Use the repo's storage and upload path.** Object storage with presigned URLs, a
   local store behind an abstraction, or existing multipart middleware. Call
   `search_lore` for bucket layout, key naming and size limits. Do not add a second
   storage mechanism.
2. **Authorise and limit before reading.** Check the caller may upload here (the
   `security-authz` skill) and that the form is CSRF-protected if cookie-authenticated.
   Enforce a maximum body size at the edge (proxy and framework), a maximum part count,
   and a request timeout; reject with `413` without buffering. Stream to storage; never
   hold a whole file in memory. For presigned uploads, sign the exact key,
   `Content-Type` and size limit (a `content-length-range` POST-policy condition, or a
   signed `Content-Length` for PUT), with a short expiry.
3. **Validate content, not labels.** Allow-list extensions (after normalising case and
   rejecting double extensions like `x.jpg.php`, NUL bytes and `:`), check the declared
   `Content-Type` against the allow-list, then detect the real type from the bytes
   (magic numbers) and reject any mismatch. None of these alone is sufficient.
4. **Defuse the dangerous formats.** Images: cap pixel dimensions before decoding
   (decompression bombs), then decode and re-encode to strip metadata and payloads.
   Archives: cap total uncompressed size and entry count, and reject entries whose
   resolved path escapes the target directory (zip slip). SVG, HTML and XML are active
   content: refuse them, sanitise them, or serve them only as attachments; parse XML with
   external entities disabled (XXE). CSV/XLSX imports: cap rows and cell size, treat every
   cell as untrusted text, and on export prefix cells starting with `=`, `+`, `-`, `@`,
   tab or CR with `'` (formula injection).
5. **Generate the storage key; never trust the filename.** Key = random id (UUID) plus
   an extension derived from the detected type. Keep the original name only as
   sanitised display metadata (length-capped, no path separators, no leading dot).
6. **Write atomically and collision-free.** Concurrent uploads are normal. Write to a
   unique temporary key (random suffix, never a timestamp or the user's name), then
   rename/commit to the final key; object storage `PUT` is already atomic per key. Insert
   the metadata row in the same transaction that marks the file available, or use a
   `pending → available` status so a half-written file is never served. Replacing a file
   (a new avatar) writes a new key and swaps the pointer with a conditional update
   (`WHERE version = ?`); it never overwrites bytes in place. Orphaned temp objects are
   swept by a job (the `scheduled-jobs` skill).
7. **Store where nothing executes.** Object storage or a directory outside the web root,
   no execute permission, no per-directory config overrides; private by default and
   access-checked on every read.
8. **Serve safely.** Presigned GET with a short expiry, or an authenticated route that
   sets `Content-Disposition: attachment` for anything not meant to render inline, the
   stored detected `Content-Type`, `X-Content-Type-Options: nosniff`, and ideally a
   separate cookieless origin with a restrictive CSP (`default-src 'none'`) so a
   malicious file cannot run in the app's origin.
9. **Scan and quarantine where the repo requires it** (malware scan, CDR, moderation)
   asynchronously through a job (the `background-jobs` skill); the file stays
   unavailable until cleared.

## Tests (one per behaviour, each exercising it for real)

- Oversize body rejected with `413` before the handler reads it; part-count cap enforced.
- Extension/type mismatch, double extension, and a renamed executable are rejected.
- Traversal filenames (`../../x`, `..\\x`, NUL) never reach the storage key.
- Valid upload is stored under a generated key and its metadata row exists.
- **Concurrency:** N (≥ 20) parallel uploads of the same filename by the same user all
  succeed with distinct keys, no `500`, no truncated or cross-wired bytes (compare
  hashes). Two concurrent replacements of the same avatar leave exactly one winner and
  no orphaned pointer. Build it with the `concurrency-and-async` skill's step 9 recipe.
- **Failure:** an upload aborted mid-stream leaves no `available` row and no file served.
- Download headers are exact; another user's file is refused (`403`/`404`).
- Import caps rows; export formula-prefixes dangerous cells; zip-slip entry rejected.

## Done when

Every test above that the ticket's surface touches passes, and each acceptance
criterion has evidence recorded via the `record-evidence` skill (the command and its
passing output, not prose).

## Review checklist

- [ ] Limits enforced before the body is read; streaming, not buffering.
- [ ] Allow-list plus byte sniffing; dangerous formats re-encoded, refused, or attachment-only.
- [ ] Generated storage keys; unique temp names; atomic commit; no in-place overwrite.
- [ ] Private storage, authorised reads, `nosniff`, `Content-Disposition`, separate origin.
- [ ] A concurrent-upload test and an aborted-upload test exist and pass.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While placing storage you learn the bucket layout, the size limits and the separate origin user content is served from.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
