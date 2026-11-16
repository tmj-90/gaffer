/**
 * A small lexer for the inline programs the hook reads (`python -c`, `node -e`,
 * `ruby -e`, `perl -e`, `php -r` and the programs fed to them on stdin). It turns the
 * program text into tokens (identifiers, string literals with their decoded value,
 * numbers, punctuation), drops comments, and lexes the code inside string interpolation
 * (a Python f-string field, a JS template `${}`, Ruby `#{}`, a Perl `@{[ ]}` or
 * subscript, a PHP `{$ }`) as code. It also returns a mask of the characters it read as
 * text (string contents, comments), so a caller can tell where a capability word sits.
 *
 * It does not parse. One pass over the text, no regular expression with an unbounded
 * quantifier, recursion only into interpolation (bounded depth), so it is linear in the
 * program length. Anything it cannot read (an unterminated string, comment or
 * interpolation, nesting past the bound) is an error, and the caller refuses the program.
 *
 * Part of the safety hook's decision; see the map in runner/safety-hook-core.mjs.
 */

const MAX_NESTING = 24;

const ID_START = /[A-Za-z_\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_\u0080-￿]/;
const DIGIT = /[0-9]/;
const SPACE = /[ \t\r\f\v ﻿]/;

// Perl and Ruby punctuation variables: `$'`, `$"`, `` $` ``, `$;` and friends are
// variables, never the start of a string.
const PERL_PUNCT_VARS = new Set([..."&`'+!@/\\,;.0123456789<>[]^_$:?-~=%|*\"()#"]);
const RUBY_PUNCT_VARS = new Set([..."!@&`'+~=/\\,;.<>_*$?:\"0123456789"]);

// Perl quote-like operators and whether they interpolate.
const PERL_QUOTE_OPS = new Map([
  ["q", "q"],
  ["qq", "qq"],
  ["qw", "q"],
  ["qx", "qx"],
  ["qr", "qq"],
  ["m", "qq"],
  ["s", "s"],
  ["tr", "tr"],
  ["y", "tr"],
]);
const CLOSER = { "(": ")", "[": "]", "{": "}", "<": ">" };

// Tokens after which a `/` starts a regular expression rather than a division.
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "and",
  "or",
  "not",
  "if",
  "unless",
  "while",
  "until",
  "when",
  "split",
  "grep",
  "map",
  "join",
  "push",
  "unshift",
  "print",
  "puts",
  "x",
  "lt",
  "gt",
  "le",
  "ge",
  "eq",
  "ne",
  "cmp",
]);

class LexError extends Error {}

/** Decode the common backslash escapes of a C-like string body. */
function decodeEscapes(body, lang) {
  if (!body.includes("\\")) return { value: body, exact: true };
  let out = "";
  let exact = true;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== "\\" || i + 1 >= body.length) {
      out += c;
      continue;
    }
    const d = body[i + 1];
    i += 1;
    const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
    if (d in simple && !(lang === "python" && d === "e")) {
      out += simple[d];
    } else if (d === "x") {
      let hex = "";
      if (body[i + 1] === "{") {
        const close = body.indexOf("}", i + 2);
        if (close === -1 || close - i > 10) {
          exact = false;
          continue;
        }
        hex = body.slice(i + 2, close);
        i = close;
      } else {
        while (hex.length < 2 && /[0-9a-fA-F]/.test(body[i + 1] ?? "")) {
          hex += body[i + 1];
          i += 1;
        }
      }
      const cp = parseInt(hex, 16);
      if (Number.isFinite(cp) && cp <= 0x10ffff) out += String.fromCodePoint(cp);
      else exact = false;
    } else if (d === "u" || d === "U") {
      let hex = "";
      if (body[i + 1] === "{") {
        const close = body.indexOf("}", i + 2);
        if (close === -1 || close - i > 10) {
          exact = false;
          continue;
        }
        hex = body.slice(i + 2, close);
        i = close;
      } else {
        const want = d === "U" ? 8 : 4;
        while (hex.length < want && /[0-9a-fA-F]/.test(body[i + 1] ?? "")) {
          hex += body[i + 1];
          i += 1;
        }
      }
      const cp = parseInt(hex, 16);
      if (Number.isFinite(cp) && cp <= 0x10ffff) out += String.fromCodePoint(cp);
      else exact = false;
    } else if (/[0-7]/.test(d)) {
      let oct = d;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) {
        oct += body[i + 1];
        i += 1;
      }
      out += String.fromCodePoint(parseInt(oct, 8));
    } else if (d === "N" || d === "c" || d === "o" || d === "p" || d === "P") {
      // A named character (`\N{...}`), a control character, a regex class: not decoded.
      exact = false;
      out += "\\" + d;
    } else if (d === "\n") {
      // A line continuation inside a string.
    } else {
      out += d;
    }
  }
  return { value: out, exact };
}

class Lexer {
  constructor(lang, src, opts = {}) {
    this.lang = lang;
    this.src = src;
    this.n = src.length;
    this.toks = [];
    this.mask = new Uint8Array(src.length);
    this.depth = 0;
    this.perlTick = Boolean(opts.perlTick);
    this.heredocs = []; // pending heredoc bodies (Ruby, Perl): { term, squiggly, interp, tok }
  }

  fail(msg, at) {
    throw new LexError(`${msg} at offset ${at}`);
  }

  unmask(regions) {
    for (const [a, b] of regions) for (let k = a; k < b; k += 1) this.mask[k] = 0;
  }

  markText(a, b) {
    for (let k = a; k < b && k < this.n; k += 1) this.mask[k] = 1;
  }

  push(tok) {
    this.toks.push(tok);
    return tok;
  }

  lastSig() {
    return this.toks.length ? this.toks[this.toks.length - 1] : null;
  }

  // Whether the previous token leaves the lexer expecting an operand (so `/` starts a
  // regular expression, `<` a Perl readline, `%` a Ruby literal, `?x` a Ruby character).
  expectOperand() {
    const t = this.lastSig();
    if (!t) return true;
    if (t.t === "p") return !/^(?:\)|\]|\}|\+\+|--)$/.test(t.v);
    if (t.t === "id") return REGEX_AFTER_WORDS.has(t.v);
    return false;
  }

  /** Lex code from index i until EOF or the closer `stop` at depth 0; return the index after it. */
  code(i, stop = null) {
    this.depth += 1;
    if (this.depth > MAX_NESTING) this.fail("nesting too deep", i);
    let depth = 0;
    let bd = 0; // depth of every bracket kind, for a Python format spec
    const opener = stop ? { "}": "{", "]": "[", ")": "(" }[stop] : null;
    let ws = false;
    let nl = true;
    while (i < this.n) {
      const c = this.src[i];
      if (c === "\n") {
        i = this.newline(i);
        ws = true;
        nl = true;
        continue;
      }
      if (SPACE.test(c)) {
        i += 1;
        ws = true;
        continue;
      }
      if (stop && c === stop && depth === 0) {
        this.depth -= 1;
        return i + 1;
      }
      if (
        this.lang === "python" &&
        stop === "}" &&
        c === ":" &&
        bd === 0 &&
        this.src[i + 1] !== "="
      ) {
        // An f-string field's format spec is text, with nested `{fields}` in it.
        let k = i + 1;
        while (k < this.n && this.src[k] !== "}") {
          if (this.src[k] === "{") k = this.code(k + 1, "}");
          else {
            this.mask[k] = 1;
            k += 1;
          }
        }
        if (k >= this.n) this.fail("unterminated f-string field", i);
        this.depth -= 1;
        return k + 1;
      }
      if (c === "(" || c === "[" || c === "{") bd += 1;
      else if (c === ")" || c === "]" || c === "}") bd -= 1;
      if (opener && c === opener) depth += 1;
      if (stop && c === stop) depth -= 1;
      const before = this.toks.length;
      i = this.one(i);
      for (let k = before; k < this.toks.length; k += 1) {
        if (k === before) {
          this.toks[k].ws = ws;
          this.toks[k].nl = nl;
        }
      }
      ws = false;
      nl = false;
    }
    if (stop) this.fail(`unterminated interpolation (no ${stop})`, i);
    this.depth -= 1;
    return i;
  }

  // At a newline: read any heredoc bodies that were opened on the line just ended.
  newline(i) {
    i += 1;
    while (this.heredocs.length) {
      const h = this.heredocs.shift();
      i = this.heredocBody(i, h);
    }
    return i;
  }

  heredocBody(i, h) {
    const start = i;
    while (i <= this.n) {
      let eol = this.src.indexOf("\n", i);
      if (eol === -1) eol = this.n;
      const line = this.src.slice(i, eol);
      const bare = h.squiggly ? line.replace(/^[ \t]+/, "") : line;
      if (bare === h.term || (this.lang === "php" && bare.replace(/[;,)\s].*$/, "") === h.term)) {
        const body = this.src.slice(start, i);
        this.markText(start, i);
        h.tok.v = h.interp ? decodeEscapes(body, this.lang).value : body;
        if (h.interp) this.interpolations(start, i, h.tok);
        if (this.lang === "php") return i; // PHP: the terminator line continues as code
        return eol + 1;
      }
      if (eol >= this.n) break;
      i = eol + 1;
    }
    this.fail(`unterminated heredoc (${h.term})`, start);
    return i;
  }

  // Lex the code inside the interpolations of an already-scanned string body [a, b).
  interpolations(a, b, tok) {
    const s = this.src;
    for (let k = a; k < b; k += 1) {
      const c = s[k];
      if (c === "\\") {
        k += 1;
        continue;
      }
      const next = s[k + 1];
      if (this.lang === "ruby" && c === "#" && next === "{") {
        tok.interp = true;
        this.push({ t: "p", v: ";", s: k, e: k });
        k = this.code(k + 2, "}") - 1;
        this.push({ t: "p", v: ";", s: k, e: k });
      } else if (
        this.lang === "php" &&
        ((c === "{" && next === "$") || (c === "$" && next === "{"))
      ) {
        tok.interp = true;
        this.push({ t: "p", v: ";", s: k, e: k });
        k = this.code(k + (c === "{" ? 1 : 2), "}") - 1;
        this.push({ t: "p", v: ";", s: k, e: k });
      } else if (this.lang === "perl" && (c === "$" || c === "@")) {
        let j = k + 1;
        if (s[j] === "{") {
          tok.interp = true;
          this.push({ t: "p", v: ";", s: k, e: k });
          j = this.code(j + 1, "}");
        } else {
          if (s[j] === "$") j += 1;
          const st = j;
          while (j < b && (ID_PART.test(s[j]) || (s[j] === ":" && s[j + 1] === ":"))) {
            j += s[j] === ":" ? 2 : 1;
          }
          if (j === st) continue;
        }
        // Subscripts after the variable are code: `$h{...}`, `$a[...]`, `$r->{...}`.
        for (;;) {
          if (s[j] === "-" && s[j + 1] === ">" && (s[j + 2] === "[" || s[j + 2] === "{")) j += 2;
          if (s[j] === "[" || s[j] === "{") {
            tok.interp = true;
            this.push({ t: "p", v: ";", s: j, e: j });
            j = this.code(j + 1, s[j] === "[" ? "]" : "}");
            continue;
          }
          break;
        }
        this.push({ t: "p", v: ";", s: j, e: j });
        k = j - 1;
      }
    }
  }

  // Ruby and PHP find the end of an interpolating string past the code in it (`"a#{f("b")}"`,
  // `"{$a["k"]}"`): scan the body from i, lexing each interpolation as code, and return
  // the index of the closer. The code regions are recorded so they are not masked as text.
  scanInterp(i, open, close, tokHolder) {
    const s = this.src;
    let depth = 0;
    for (let k = i; k < this.n; k += 1) {
      const c = s[k];
      if (c === "\\") {
        k += 1;
        continue;
      }
      const next = s[k + 1];
      if (this.lang === "ruby" && c === "#" && next === "{") {
        tokHolder.interp = true;
        this.push({ t: "p", v: ";", s: k, e: k });
        const end = this.code(k + 2, "}");
        tokHolder.codeRegions.push([k, end]);
        this.push({ t: "p", v: ";", s: end, e: end });
        k = end - 1;
        continue;
      }
      if (this.lang === "php" && ((c === "{" && next === "$") || (c === "$" && next === "{"))) {
        tokHolder.interp = true;
        this.push({ t: "p", v: ";", s: k, e: k });
        const end = this.code(k + (c === "{" ? 1 : 2), "}");
        tokHolder.codeRegions.push([k, end]);
        this.push({ t: "p", v: ";", s: end, e: end });
        k = end - 1;
        continue;
      }
      if (open !== close && c === open) depth += 1;
      else if (c === close) {
        if (depth === 0) return k;
        depth -= 1;
      }
    }
    this.fail(`unterminated string (no ${close})`, i);
    return this.n;
  }

  // An interpolating Ruby / PHP string from just after its opener: its token.
  interpString(start, a, open, close, kind) {
    const holder = { interp: false, codeRegions: [] };
    const end = this.scanInterp(a, open, close, holder);
    const tok = this.stringTok(start, a, end, end + 1, kind, false);
    this.unmask(holder.codeRegions);
    tok.interp = holder.interp;
    return { tok, end };
  }

  // A quoted body from i (just after the opening delimiter); returns the index of the closer.
  scanDelimited(i, open, close, escapes = true) {
    let depth = 0;
    for (let k = i; k < this.n; k += 1) {
      const c = this.src[k];
      if (escapes && c === "\\") {
        k += 1;
        continue;
      }
      if (open !== close && c === open) depth += 1;
      else if (c === close) {
        if (depth === 0) return k;
        depth -= 1;
      }
    }
    this.fail(`unterminated string (no ${close})`, i);
    return this.n;
  }

  // A string: body [a, b), the token's kind, and whether it interpolates.
  stringTok(s, a, b, e, kind, interp, rawish = false) {
    this.markText(a, b);
    const body = this.src.slice(a, b);
    const dec =
      rawish || kind === "single" ? { value: unescapeSingle(body, this.lang), exact: true } : null;
    const { value, exact } = dec ?? decodeEscapes(body, this.lang);
    const tok = this.push({ t: "str", v: value, exact, s, e, kind, interp: false });
    if (interp) this.interpolations(a, b, tok);
    return tok;
  }

  one(i) {
    const s = this.src;
    const c = s[i];
    const L = this.lang;
    const next = s[i + 1];
    // Comments.
    if (
      ((L === "python" || L === "ruby" || L === "perl") && c === "#") ||
      (L === "php" && c === "#" && next !== "[")
    ) {
      let eol = s.indexOf("\n", i);
      if (eol === -1) eol = this.n;
      this.markText(i, eol);
      return eol;
    }
    if ((L === "js" || L === "php") && c === "/" && next === "/") {
      let eol = s.indexOf("\n", i);
      if (eol === -1) eol = this.n;
      this.markText(i, eol);
      return eol;
    }
    if ((L === "js" || L === "php") && c === "/" && next === "*") {
      const close = s.indexOf("*/", i + 2);
      if (close === -1) this.fail("unterminated comment", i);
      this.markText(i, close + 2);
      return close + 2;
    }
    const prevTok = this.lastSig();
    if (
      (i === 0 || s[i - 1] === "\n") &&
      c === "=" &&
      (L === "ruby" || (L === "perl" && (!prevTok || /^[;{}]$/.test(prevTok.v)))) &&
      /[A-Za-z]/.test(next ?? "")
    ) {
      // Ruby =begin ... =end, Perl POD (=head1 ... =cut).
      const endWord = L === "ruby" ? "\n=end" : "\n=cut";
      const close = s.indexOf(endWord, i);
      const end =
        close === -1
          ? this.n
          : s.indexOf("\n", close + 1) === -1
            ? this.n
            : s.indexOf("\n", close + 1);
      if (close === -1 && L === "ruby") this.fail("unterminated =begin", i);
      this.markText(i, end);
      return end;
    }
    // Variables with sigils.
    if (
      (L === "perl" || L === "ruby" || L === "php") &&
      (c === "$" || c === "@" || (L === "perl" && (c === "%" || c === "&" || c === "*")))
    ) {
      return this.sigil(i);
    }
    // Numbers.
    if (DIGIT.test(c) || (c === "." && DIGIT.test(next ?? ""))) {
      let k = i + 1;
      while (k < this.n && /[0-9A-Za-z_.]/.test(s[k])) {
        if (s[k] === "." && s[k + 1] === ".") break;
        k += 1;
      }
      this.push({ t: "num", v: s.slice(i, k), s: i, e: k });
      return k;
    }
    // Identifiers (and string prefixes, quote-like operators).
    if (ID_START.test(c) || (L === "js" && (c === "$" || (c === "\\" && next === "u")))) {
      return this.ident(i);
    }
    // Strings.
    if (c === "'" || c === '"' || c === "`") return this.quote(i, c);
    if (c === "/" && L === "ruby" && this.expectOperand()) {
      const { tok, end } = this.interpString(i, i + 1, "/", "/", "regex");
      let k = end + 1;
      while (k < this.n && /[A-Za-z]/.test(s[k])) k += 1;
      tok.flags = s.slice(end + 1, k);
      return k;
    }
    if (c === "/" && (L === "js" || L === "perl") && this.expectOperand()) {
      const close = this.regexEnd(i + 1);
      const tok = this.stringTok(i, i + 1, close, close + 1, "regex", L !== "js");
      let k = close + 1;
      while (k < this.n && /[A-Za-z]/.test(s[k])) k += 1;
      tok.flags = s.slice(close + 1, k);
      return k;
    }
    if (
      L === "ruby" &&
      c === "%" &&
      this.expectOperand() &&
      next &&
      /[qQwWiIrsx(\[{<|!\/^]/.test(next)
    ) {
      return this.rubyPercent(i);
    }
    if (L === "ruby" && c === ":" && next === '"') {
      return this.quote(i + 1, '"');
    }
    if (L === "ruby" && c === "?" && this.expectOperand() && next && !/\s/.test(next)) {
      // A character literal `?a`.
      this.push({ t: "str", v: next, exact: true, s: i, e: i + 2, kind: "char", interp: false });
      this.markText(i + 1, i + 2);
      return i + 2;
    }
    if (
      (L === "ruby" || L === "perl") &&
      c === "<" &&
      next === "<" &&
      /[~\-"'`A-Za-z_]/.test(s[i + 2] ?? "")
    ) {
      const h = this.heredocStart(i + 2);
      if (h) return h;
    }
    if (L === "php" && c === "<" && next === "<" && s[i + 2] === "<") {
      const h = this.heredocStart(i + 3);
      if (h) return h;
    }
    if (L === "perl" && c === "<" && this.expectOperand()) {
      // `<STDIN>`, `<$fh>`, `<*.txt>`: a readline or a glob, interpolated like a string.
      const close = s.indexOf(">", i + 1);
      const eol = s.indexOf("\n", i + 1);
      if (close !== -1 && (eol === -1 || close < eol) && close - i < 256) {
        this.stringTok(i, i + 1, close, close + 1, "readline", true);
        return close + 1;
      }
    }
    // Punctuation: a few multi-character operators stay together.
    const three = s.slice(i, i + 3);
    if (
      three === "..." ||
      three === "**=" ||
      three === "<=>" ||
      three === "===" ||
      three === "!=="
    ) {
      this.push({ t: "p", v: three, s: i, e: i + 3 });
      return i + 3;
    }
    const two = s.slice(i, i + 2);
    if (
      [
        "::",
        "->",
        "=>",
        "=~",
        "!~",
        "==",
        "!=",
        "<=",
        ">=",
        "&&",
        "||",
        "++",
        "--",
        "**",
        "<<",
        ">>",
        "?.",
        "+=",
        "-=",
      ].includes(two)
    ) {
      this.push({ t: "p", v: two, s: i, e: i + 2 });
      return i + 2;
    }
    if (c === "\\" && next === "\n") return i + 2; // a line continuation
    this.push({ t: "p", v: c, s: i, e: i + 1 });
    return i + 1;
  }

  ident(i) {
    const s = this.src;
    const L = this.lang;
    let k = i;
    let name = "";
    while (k < this.n) {
      const c = s[k];
      if (ID_PART.test(c) || (L === "js" && c === "$")) {
        name += c;
        k += 1;
      } else if (L === "js" && c === "\\" && s[k + 1] === "u") {
        // `eval` is the identifier `eval`.
        let m = /^\\u\{([0-9a-fA-F]{1,6})\}/.exec(s.slice(k, k + 10));
        if (!m) m = /^\\u([0-9a-fA-F]{4})/.exec(s.slice(k, k + 6));
        if (!m) this.fail("bad identifier escape", k);
        name += String.fromCodePoint(parseInt(m[1], 16));
        k += m[0].length;
      } else if (L === "perl" && c === ":" && s[k + 1] === ":" && ID_START.test(s[k + 2] ?? "")) {
        name += "::";
        k += 2;
      } else if (L === "perl" && this.perlTick && c === "'" && ID_START.test(s[k + 1] ?? "")) {
        // Perl's old package separator: `CORE'system` is `CORE::system`.
        name += "::";
        k += 1;
      } else if (L === "ruby" && (c === "?" || c === "!") && s[k + 1] !== "=") {
        name += c;
        k += 1;
        break;
      } else break;
    }
    const norm = name.normalize("NFKC");
    // Python string prefixes.
    if (
      L === "python" &&
      /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/.test(name) &&
      (s[k] === "'" || s[k] === '"')
    ) {
      return this.quote(k, s[k], name.toLowerCase(), i);
    }
    // Perl quote-like operators: only when the delimiter follows at once, and not as a
    // hash key or method name (`$h{s}`, `->s`, `s => 1`).
    if (L === "perl" && PERL_QUOTE_OPS.has(name)) {
      const prev = this.lastSig();
      const d = s[k];
      const keyish = prev && prev.t === "p" && (prev.v === "->" || prev.v === "-");
      const fat = d === "=" && s[k + 1] === ">";
      if (
        !keyish &&
        !fat &&
        d &&
        !/[\sA-Za-z0-9_,;)=]/.test(d) &&
        !(d === "}" && prev?.v === "{")
      ) {
        return this.perlQuote(i, k, name);
      }
    }
    this.push({ t: "id", v: norm, s: i, e: k });
    return k;
  }

  sigil(i) {
    const s = this.src;
    const L = this.lang;
    const c = s[i];
    let k = i + 1;
    if (L === "perl" && c === "$" && s[k] === "#") {
      // `$#array`, `$#{expr}`, `$#$ref`: the `#` is part of the variable, never a comment.
      k += 1;
      if (!ID_START.test(s[k] ?? "")) {
        this.push({ t: "var", v: "#", sigil: "$", s: i, e: k });
        return k;
      }
    }
    if (L === "ruby" && c === "@" && s[k] === "@") k += 1;
    if (L === "perl" && c === "$" && s[k] === "^" && /[A-Z]/.test(s[k + 1] ?? "")) {
      this.push({ t: "var", v: "^" + s[k + 1], sigil: "$", s: i, e: k + 2 });
      return k + 2;
    }
    if (ID_START.test(s[k] ?? "") || (L === "perl" && s[k] === ":" && s[k + 1] === ":")) {
      let name = "";
      while (
        k < this.n &&
        (ID_PART.test(s[k]) ||
          (L === "perl" && s[k] === ":" && s[k + 1] === ":") ||
          (L === "perl" && this.perlTick && s[k] === "'" && ID_START.test(s[k + 1] ?? "")))
      ) {
        if (s[k] === ":") {
          name += "::";
          k += 2;
        } else if (s[k] === "'") {
          name += "::";
          k += 1;
        } else {
          name += s[k];
          k += 1;
        }
      }
      this.push({ t: "var", v: name, sigil: c, s: i, e: k });
      return k;
    }
    if (
      c === "$" &&
      L === "perl" &&
      PERL_PUNCT_VARS.has(s[k] ?? "") &&
      s[k] !== "{" &&
      s[k] !== "#"
    ) {
      this.push({ t: "var", v: s[k], sigil: "$", s: i, e: k + 1 });
      return k + 1;
    }
    if (c === "$" && L === "ruby" && RUBY_PUNCT_VARS.has(s[k] ?? "")) {
      this.push({ t: "var", v: s[k], sigil: "$", s: i, e: k + 1 });
      return k + 1;
    }
    if (c === "$" && L === "ruby" && s[k] === "-" && /[0-9A-Za-z_]/.test(s[k + 1] ?? "")) {
      this.push({ t: "var", v: "-" + s[k + 1], sigil: "$", s: i, e: k + 2 });
      return k + 2;
    }
    // A bare sigil (`${`, `@{`, `$$`, `&$f`, `%$h`, `*{"name"}`, PHP `$$x`): punctuation.
    this.push({ t: "p", v: c, s: i, e: i + 1 });
    return i + 1;
  }

  quote(i, q, prefix = "", tokStart = i) {
    const s = this.src;
    const L = this.lang;
    if (L === "python") {
      const triple = s.slice(i, i + 3) === q.repeat(3);
      const raw = prefix.includes("r");
      const f = prefix.includes("f");
      const regions = [];
      const open = triple ? 3 : 1;
      let k = i + open;
      for (;;) {
        if (k >= this.n) this.fail("unterminated string", i);
        const c = s[k];
        if (c === "\\") {
          k += 2;
          continue;
        }
        if (!triple && c === "\n") this.fail("newline in string", i);
        if (f && c === "{") {
          if (s[k + 1] === "{") {
            k += 2;
            continue;
          }
          const end = this.code(k + 1, "}");
          regions.push([k, end]);
          k = end;
          continue;
        }
        if (c === q && (!triple || s.slice(k, k + 3) === q.repeat(3))) break;
        k += 1;
      }
      const tok = this.stringTok(
        tokStart,
        i + open,
        k,
        k + open,
        f ? "fstring" : "double",
        false,
        raw,
      );
      this.unmask(regions);
      if (f) tok.interp = true;
      if (raw) tok.v = s.slice(i + open, k);
      return k + open;
    }
    if (L === "js" && q === "`") {
      let k = i + 1;
      let interp = false;
      const regions = [];
      for (;;) {
        if (k >= this.n) this.fail("unterminated template", i);
        const c = s[k];
        if (c === "\\") {
          k += 2;
          continue;
        }
        if (c === "$" && s[k + 1] === "{") {
          interp = true;
          const end = this.code(k + 2, "}");
          regions.push([k, end]);
          k = end;
          continue;
        }
        if (c === "`") break;
        k += 1;
      }
      const tok = this.stringTok(i, i + 1, k, k + 1, "template", false);
      this.unmask(regions);
      tok.interp = interp;
      return k + 1;
    }
    if ((L === "ruby" && (q === '"' || q === "`")) || (L === "php" && q === '"')) {
      const { tok, end } = this.interpString(i, i + 1, q, q, q === "`" ? "command" : "double");
      if (q === "`") tok.command = true;
      return end + 1;
    }
    // Single-line strings in JS; multi-line elsewhere.
    let k = i + 1;
    for (;;) {
      if (k >= this.n) this.fail("unterminated string", i);
      const c = s[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "\n" && L === "js") this.fail("newline in string", i);
      if (c === q) break;
      k += 1;
    }
    if (q === "`") {
      // A Ruby, Perl or PHP backtick: a command.
      const tok = this.stringTok(i, i + 1, k, k + 1, "command", true);
      tok.command = true;
      return k + 1;
    }
    const interp = q === '"' && (L === "ruby" || L === "perl" || L === "php");
    this.stringTok(i, i + 1, k, k + 1, q === "'" ? "single" : "double", interp, q === "'");
    return k + 1;
  }

  regexEnd(i) {
    let inClass = false;
    for (let k = i; k < this.n; k += 1) {
      const c = this.src[k];
      if (c === "\\") {
        k += 1;
        continue;
      }
      if (c === "\n" && this.lang === "js") this.fail("newline in regex", i);
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return k;
    }
    this.fail("unterminated regex", i);
    return this.n;
  }

  perlQuote(start, k, op) {
    const s = this.src;
    const kind = PERL_QUOTE_OPS.get(op);
    const open = s[k];
    const close = CLOSER[open] ?? open;
    const interp = kind !== "q" && kind !== "tr" && open !== "'";
    let end = this.scanDelimited(k + 1, open, close);
    const tok = this.stringTok(
      start,
      k + 1,
      end,
      end + 1,
      kind === "qx" ? "command" : "perl-" + op,
      interp,
    );
    if (kind === "qx") tok.command = true;
    let after = end + 1;
    if (kind === "s" || kind === "tr") {
      // The replacement part: `s/a/b/`, or `s{a}{b}` with its own delimiters.
      let open2 = open;
      let k2 = end + 1;
      if (open !== close) {
        while (k2 < this.n && /\s/.test(s[k2])) k2 += 1;
        open2 = s[k2];
        if (!open2) this.fail("unterminated substitution", start);
        k2 += 1;
      } else k2 = end + 1;
      const close2 = CLOSER[open2] ?? open2;
      const end2 = this.scanDelimited(k2, open2, close2);
      let f = end2 + 1;
      while (f < this.n && /[a-z]/.test(s[f])) f += 1;
      const flags = s.slice(end2 + 1, f);
      tok.flags = flags;
      if (kind === "s" && flags.includes("e")) {
        // `s/x/CODE/e`: the replacement is Perl code.
        this.push({ t: "p", v: ";", s: k2, e: k2 });
        const sub = new Lexer("perl", s.slice(k2, end2), { perlTick: this.perlTick });
        sub.depth = this.depth;
        sub.code(0);
        for (const t of sub.toks) this.push({ ...t, s: t.s + k2, e: t.e + k2 });
        for (let m = 0; m < sub.mask.length; m += 1) if (sub.mask[m]) this.mask[k2 + m] = 1;
        this.push({ t: "p", v: ";", s: end2, e: end2 });
        tok.evalReplacement = true;
      } else {
        this.stringTok(k2 - 1, k2, end2, end2 + 1, "perl-repl", kind === "s" && open2 !== "'");
      }
      after = f;
    } else {
      while (after < this.n && /[a-z]/.test(s[after])) after += 1;
      tok.flags = s.slice(end + 1, after);
    }
    return after;
  }

  rubyPercent(i) {
    const s = this.src;
    let k = i + 1;
    let type = "Q";
    if (/[qQwWiIrsx]/.test(s[k])) {
      type = s[k];
      k += 1;
    }
    const open = s[k];
    if (!open || /[A-Za-z0-9\s]/.test(open)) {
      this.push({ t: "p", v: "%", s: i, e: i + 1 });
      return i + 1;
    }
    const close = CLOSER[open] ?? open;
    const interp = /[QWIrx]/.test(type);
    const kind = type === "x" ? "command" : "percent-" + type;
    let end;
    let tok;
    if (interp) ({ tok, end } = this.interpString(i, k + 1, open, close, kind));
    else {
      end = this.scanDelimited(k + 1, open, close);
      tok = this.stringTok(i, k + 1, end, end + 1, kind, false);
    }
    if (type === "x") tok.command = true;
    let after = end + 1;
    if (type === "r") while (after < this.n && /[a-z]/.test(s[after])) after += 1;
    return after;
  }

  // `<<~EOS`, `<<-"EOS"`, `<<'EOS'` (Ruby, Perl), `<<<EOS` (PHP). Returns the index after
  // the opener (the body is read at the next newline), or 0 when this is not a heredoc.
  heredocStart(k) {
    const s = this.src;
    let squiggly = false;
    if (s[k] === "~" || (s[k] === "-" && this.lang === "ruby")) {
      squiggly = true;
      k += 1;
    }
    if (this.lang === "php") {
      while (s[k] === " " || s[k] === "\t") k += 1;
      squiggly = true;
    }
    let q = "";
    if (this.lang === "perl" && !squiggly) {
      // Perl allows spaces before a quoted terminator: `print << "EOF";`.
      let sp = k;
      while (s[sp] === " " || s[sp] === "\t") sp += 1;
      if (sp > k && (s[sp] === '"' || s[sp] === "'" || s[sp] === "`")) k = sp;
    }
    if (s[k] === '"' || s[k] === "'" || s[k] === "`") {
      q = s[k];
      k += 1;
    }
    const st = k;
    while (k < this.n && ID_PART.test(s[k])) k += 1;
    if (k === st) return 0;
    const term = s.slice(st, k);
    if (q) {
      if (s[k] !== q) return 0;
      k += 1;
    } else if (this.lang !== "php" && !/^[A-Z_]/.test(term)) {
      // A bare lower-case word after `<<` is more likely a shift or an append.
      return 0;
    }
    const tok = this.push({
      t: "str",
      v: "",
      exact: true,
      s: st - 2,
      e: k,
      kind: q === "`" ? "command" : "heredoc",
      interp: false,
    });
    if (q === "`") tok.command = true;
    this.heredocs.push({ term, squiggly, interp: q !== "'", tok });
    return k;
  }
}

function unescapeSingle(body, lang) {
  if (!body.includes("\\")) return body;
  if (lang === "python") return decodeEscapes(body, lang).value;
  return body.replace(/\\([\\'])/g, "$1");
}

/**
 * Lex `src` as `lang` ("python" | "js" | "ruby" | "perl" | "php"). Returns
 * { tokens, mask } or { error } when the program cannot be read.
 */
function lexProgram(lang, src, opts = {}) {
  const lx = new Lexer(lang, src, opts);
  try {
    lx.code(0);
    if (lx.heredocs.length) lx.fail("unterminated heredoc", src.length);
  } catch (e) {
    if (e instanceof LexError) return { error: e.message };
    if (e instanceof RangeError) return { error: "program too deeply nested" };
    throw e;
  }
  return { tokens: lx.toks, mask: lx.mask };
}

export { decodeEscapes, lexProgram };
