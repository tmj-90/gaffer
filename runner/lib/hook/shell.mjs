/**
 * Shell parsing: quote-aware tokenizing and the whole-command quoting check, segment
 * splitting outside quotes, quote and backslash removal, redirect tokens and
 * same-command variable substitution.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

/** Strip surrounding quotes from a shell token. */
function unquote(token) {
  return token.replace(/^['"]|['"]$/g, "");
}

// Normalise a VERB token to the command the shell would actually execute, so a
// quote/backslash-obfuscated verb can't slip past the verb switches. At runtime
// `'cp'`, `"cp"`, `\cp`, and `c'p'` all invoke `cp` — the quotes/backslashes only
// suppress alias/keyword expansion, they are not part of the command name. A
// unix command name never legitimately contains a quote or backslash, so
// stripping both recovers the effective verb without false collisions. Applied
// ONLY to the verb (operands keep their own quote handling via unquote()).
function normalizeVerb(token) {
  return token.replace(/['"\\]/g, "");
}

// Sentinel write/read target representing an UNVERIFIABLE path — one the hook
// cannot resolve from the segment (e.g. an `xargs <verb>` target that comes
// from STDIN). It is guaranteed to be outside every root, so classifying it
// always yields "outside" and the boundary fails CLOSED.
const UNVERIFIABLE_TARGET = "\u0000unverifiable\u0000";

// =====================================================================
// QUOTE-AWARE TOKENIZATION + FAIL-CLOSED-ON-AMBIGUITY (S-1 / S-4)
// ---------------------------------------------------------------------
// The verb extractors below used to tokenize a segment with the naive regex
//   /"[^"]*"|'[^']*'|\S+/g
// which is WRONG whenever a quoted span begins mid-token. Concretely, a quoted
// assignment value containing a space:
//   HOME="/tmp/x y" cp a /root/b
// tokenizes as ["HOME=\"/tmp/x", "y\"", "cp", "a", "/root/b"]: \S+ grabs
// `HOME="/tmp/x` (stops at the space), leaving `y"` as a bogus token. The verb
// resolver then strips `HOME="/tmp/x` as a `VAR=` assignment and reads `y"` as
// the verb, so the real `cp` and its `/root/b` destination are never seen and
// the write-boundary guard is bypassed entirely.
//
// Two-part fix:
//   1. tokenizeSegment: a quote-aware walk that groups a quoted span into the
//      token it belongs to (so `HOME="/tmp/x y"` is ONE token and `cp` is
//      correctly the verb). This ALONE closes the S-1 assignment-quoted-space
//      bypass — the destination is now seen and checked. It does not by itself
//      fail closed; that is the second part.
//   2. commandQuotingAmbiguous: a WHOLE-COMMAND check for constructs we cannot
//      cleanly resolve — a genuinely unbalanced/unpaired quote, or a $'…'/$"…"
//      ANSI-C / locale string whose escape semantics we deliberately do not
//      model. When true, the extractor surfaces the existing UNVERIFIABLE_TARGET
//      sentinel so the command is DENIED rather than slipping through.
//
// WHY this is checked on the WHOLE command, not per-segment: the segment
// splitter (`split(/&&|\|\||[;&|\n]/)`) is quote-naive and will split on a `;`
// or `|` that sits INSIDE a quoted string (e.g. a legitimate
// `python -c "...; Path('x').write_text('y')"`), manufacturing fragments with
// false-unbalanced quotes. Judging balance over the full command avoids
// false-denying those legitimate quoted bodies while still catching a real
// dangling quote, which is unbalanced at the whole-command level too.
//
// WHY fail-closed beats a cleverer parser here: this hook is a security
// boundary, not a shell. A parser that tries to fully emulate bash quoting,
// escaping, $'...', and expansion is a large, bug-prone surface, and every
// parser bug that mis-resolves a token is a silent BYPASS of the write/read
// boundary. Refusing to guess (deny on ambiguity) caps the blast radius at a
// handful of extra FALSE DENIALS for genuinely malformed/exotic commands, while
// guaranteeing no attacker-controlled quoting trick can slip a write target past
// tokenization. A few false denials are the correct trade; a single new bypass
// is not.
//
// tokenizeSegment returns the token array with surrounding quotes preserved
// (downstream unquote/stripQuotes strips them) so the existing verb/operand
// logic is unchanged.
function tokenizeSegment(segment) {
  const tokens = [];
  let cur = "";
  let has = false; // whether `cur` holds an in-progress token
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const c = segment[i];
    if (c === '"' || c === "'") {
      // Group the whole quoted span (quotes included) into the current token.
      const close = segment.indexOf(c, i + 1);
      if (close === -1) {
        // Unbalanced at the segment level: take the rest verbatim. Whole-command
        // ambiguity (commandQuotingAmbiguous) decides whether this fails closed;
        // this local fallback just avoids an infinite loop / partial token.
        cur += segment.slice(i);
        has = true;
        break;
      }
      cur += segment.slice(i, close + 1);
      has = true;
      i = close + 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      i += 1;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * WHOLE-COMMAND quoting-ambiguity check (S-1/S-4 fail-closed gate). Returns true
 * when the command contains a construct the tokenizer cannot resolve without
 * guessing: a $'…'/$"…" ANSI-C / locale quote (escape semantics we do not
 * model), or a genuinely unbalanced/unpaired quote across the whole string.
 * Callers translate `true` into the UNVERIFIABLE_TARGET sentinel → DENY.
 */
function commandQuotingAmbiguous(cmd) {
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    // $'…' (ANSI-C) / $"…" (locale): unmodelled escape semantics → fail closed.
    if (c === "$" && i + 1 < n && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      return true;
    }
    if (c === '"' || c === "'") {
      const close = cmd.indexOf(c, i + 1);
      if (close === -1) return true; // dangling quote across the whole command
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/** Split a redirect glued to a word (`bash</x`, `3</x`) into word, operator, target. */
function splitRedirectToken(tk) {
  const m = tk.match(/^([^'"<>]*?)(\d*(?:<<<|<<|<>|>>|<|>)&?)([\s\S]*)$/);
  return m ? [m[1], m[2], m[3]].filter(Boolean) : [tk];
}

/** Replace `$NAME` / `${NAME}` for the shell variables recorded earlier in the command. */
function substituteVars(tk, vars) {
  if (!vars.size || !tk.includes("$")) return tk;
  return tk.replace(/\$\{(\w+)\}|\$([A-Za-z_]\w*)/g, (whole, a, b) =>
    vars.has(a ?? b) ? vars.get(a ?? b) : whole,
  );
}

// A word as the shell would hand it to the program: quotes and backslashes gone; a
// separator that was inside quotes made inert so it cannot start a new segment.
function normalizeWord(token) {
  return token.replace(/['"\\]/g, "").replace(/[;&|\n]/g, "_");
}

// Drop redirections (`< file`, `2>&1`, `>> log`) from a word list: they are not
// arguments of the program, so `xargs wg < args` has nothing after `wg`.
function stripRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (/^[0-9]*(?:<<<|<<|<>|>>|<|>)&?[0-9]*$/.test(w)) {
      if (!/&[0-9]+$/.test(w)) i += 1; // the operator's target is the next word
      continue;
    }
    if (
      /^[0-9]*(?:<<<|<<|<>|>>|<|>)&?[^<>&\s]/.test(w) &&
      !w.startsWith("<(") &&
      !w.startsWith(">(")
    )
      continue;
    out.push(w);
  }
  return out;
}

// Split a command into segments on `;`, `|`, `&`, `&&`, `||` and newlines OUTSIDE quotes.
// The views must never read a separator inside a quoted word as a command boundary
// (`echo "a | xargs wg"` is one echo). Unbalanced quotes take the rest as one segment;
// commandQuotingAmbiguous fails such a command closed elsewhere.
function splitSegmentsQuoteAware(cmd) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[i + 1];
      i += 1;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      out.push(cur);
      cur = "";
      continue; // a doubled `&&`/`||` just yields an empty segment, skipped by the caller
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

// A word as the program receives it, for reading names and flags (quotes, backslashes gone).
function shellWord(token) {
  return token.replace(/['"\\]/g, "");
}

export {
  UNVERIFIABLE_TARGET,
  commandQuotingAmbiguous,
  normalizeVerb,
  normalizeWord,
  shellWord,
  splitRedirectToken,
  splitSegmentsQuoteAware,
  stripRedirects,
  substituteVars,
  tokenizeSegment,
  unquote,
};
