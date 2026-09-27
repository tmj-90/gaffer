---
name: file-uploads
description: Use when a ticket lets users send files — avatars, documents, CSV imports, attachments — or serves them back, and the path must be safe against oversized, malicious, or mis-typed content, store files outside the web root or in object storage, and never trust the client's filename or content type. Invoke for "let users upload X", "add an import", "serve the attachment", or any multipart or presigned-URL work.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Handle file uploads and downloads safely

An upload is untrusted input that is large, binary, and often stored for years. Limit it
before you read it, verify what it really is, store it under a name you chose in a place
that cannot execute, and serve it back with headers that stop the browser guessing.

## Steps

1. **Use the repo's storage and upload path.** Object storage with presigned URLs, a
   local store behind an abstraction, an existing multipart middleware. Call
   `search_lore` for conventions (bucket layout, key naming, size limits). Do not add a
   second storage mechanism.
2. **Limit before reading.** Enforce a maximum size at the edge (proxy or framework
   limit), a maximum count per request, and a request timeout; reject with `413` early
   rather than buffering a gigabyte to discover it is too big. Stream to storage; never
   hold whole files in memory.
3. **Validate the content, not the label.** Allow-list accepted types; detect the real
   type from the bytes (magic numbers) and reject on mismatch with the declared type or
   extension; for images, decode and re-encode (strips embedded payloads and metadata
   you should not keep); for CSV/XLSX imports, parse with limits on rows and cell size
   and treat every cell as untrusted text (formula injection: prefix `=`, `+`, `-`, `@`
   when exporting).
4. **Never trust the filename.** Generate the storage key yourself (an id plus a safe
   extension derived from the detected type); keep the original name only as metadata,
   sanitised, for display. Path traversal, null bytes, and overlong names are rejected
   at the boundary.
5. **Store where nothing executes.** Object storage or a directory outside the web
   root with no execute permission and no server-side rendering of user content;
   private by default, access-checked on every read (the `security-authz` skill).
6. **Serve safely.** Downloads via presigned URLs or an authenticated route that sets
   `Content-Disposition` (attachment for anything not meant to render inline), the
   detected `Content-Type`, `X-Content-Type-Options: nosniff`, and no cookies on a
   separate origin/CDN for user content so a malicious SVG or HTML cannot run in your
   app's origin.
7. **Scan and quarantine where the repo requires it** (malware scanning, moderation)
   asynchronously through a job (the `background-jobs` skill); files are unavailable
   until cleared.
8. **Test**: oversize rejected early, type mismatch rejected, traversal filename
   rejected, valid upload stored under a generated key, download headers correct,
   unauthorised read refused, import rows capped and formula-prefixed on export.
   Evidence with the `record-evidence` skill.

## Rules

- Size, count and time limits enforced before the body is read; stream, never buffer.
- Type detected from bytes and allow-listed; images re-encoded; imports parsed with
  limits and cells treated as untrusted text.
- Storage keys are generated; original names are display metadata only.
- Stored outside any executable or app-origin path; private by default; access-checked
  on read.
- Served with `Content-Disposition`, detected type, `nosniff`, off the app origin.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While placing storage you learn the bucket layout, the size limits and the separate origin user content is served from.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
