// =====================================================================
// lib/agent-io.mjs — the ONE copy of the helpers every headless agent lane uses to
// read a model's reply and to quarantine untrusted text in its prompt.
//
// These used to be copied into bin/decompose.mjs, bin/spec-author.mjs and
// lib/onboard-analyze.mjs, and the copies drifted: decompose was fixed to prefer the
// last PHASE-BEARING block (the intermittent "unknown result phase: undefined" when the
// model adds an example ```json block after its envelope), while spec-author — whose
// comment still claimed to be "byte-for-byte the decompose.mjs extractor" — and
// onboard-analyze kept "the last fence wins". Onboard's brace counter had drifted the
// other way (it skips braces inside strings; the others did not). One module now, the
// best of each; the bin files re-export their old names so callers and tests keep working.
// =====================================================================

/**
 * The last balanced top-level {...} substring of `text`, or null. Brace-counting that
 * skips string literals, so a "{" or "}" inside a JSON string value does not end (or
 * start) the object early.
 */
export function lastBalancedObject(text) {
  let depth = 0;
  let start = -1;
  let last = null;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) last = text.slice(start, i + 1);
    }
  }
  return last;
}

/**
 * Pull the model's result envelope out of its text. Collects EVERY parseable JSON
 * block — all fenced ```json blocks plus the last bare {...} — and returns the LAST one
 * `isEnvelope` accepts: a Set of recognised `phase` values (decompose: clarify/plan/error,
 * spec-author: clarify/spec/error) or a predicate (onboard's card/digest results carry no
 * phase). Only if none is accepted does it fall back to the last parseable object, so the
 * caller's validator still reports a clean error. Returns the parsed value or null.
 *
 * Why not "the last block": the model sometimes emits an extra JSON-ish block AFTER the
 * envelope (an example inside a question, a trailing snippet); the last block is then a
 * phase-less object and the run fails.
 */
export function extractLastJsonBlock(text, isEnvelope = null) {
  if (!text) return null;
  const parsed = [];
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    try {
      parsed.push(JSON.parse(match[1]));
    } catch {
      /* skip an unparseable fence */
    }
  }
  const bare = lastBalancedObject(text);
  if (bare) {
    try {
      parsed.push(JSON.parse(bare));
    } catch {
      /* skip */
    }
  }
  if (parsed.length === 0) return null;
  const accept =
    isEnvelope instanceof Set
      ? (o) => o && typeof o === "object" && isEnvelope.has(o.phase)
      : typeof isEnvelope === "function"
        ? isEnvelope
        : null;
  if (accept) {
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      try {
        if (accept(parsed[i])) return parsed[i];
      } catch {
        /* a throwing predicate rejects that block */
      }
    }
  }
  return parsed[parsed.length - 1];
}

/**
 * Wrap an UNTRUSTED field in a delimited envelope (P1 prompt-injection): an embedded
 * "SYSTEM:" / "ignore previous instructions" line must land as DATA, not as a fresh
 * instruction line. Any literal <untrusted-…> / </untrusted-…> delimiter the data
 * carries — of ANY tag, so it can neither close its own envelope nor fake another — is
 * stripped. `singleLine` collapses whitespace runs (an injected newline cannot open a
 * new instruction line); `block` puts the data on its own lines between the tags.
 */
export function quarantine(tag, value, { singleLine = false, block = false } = {}) {
  let data = String(value ?? "").replace(/<\/?\s*untrusted-[A-Za-z0-9_-]*\s*>/gi, "");
  if (singleLine) data = data.replace(/\s+/g, " ").trim();
  return block
    ? `<untrusted-${tag}>\n${data}\n</untrusted-${tag}>`
    : `<untrusted-${tag}>${data}</untrusted-${tag}>`;
}
