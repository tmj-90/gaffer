import { describe, expect, it } from "vitest";

import { distillOutput, isSignalLine } from "../src/runtime/dod/distillOutput.js";
import { extractFailure } from "../src/runtime/dod/extractFailure.js";
import { joinAwkLines, splitAwkRecords } from "../src/runtime/dod/awkText.js";

// The pure functions operate on the file's BYTES (the runner's mawk is byte-
// oriented — see distillOutput.ts). `toBytes` decodes a UTF-8 string to the
// latin1 byte-view the live CLI passes; it is the identity for ASCII.
const toBytes = (s: string): string => Buffer.from(s, "utf8").toString("latin1");
// A newline-TERMINATED document (every line + "\n"), in the byte-view — matching
// how the raw gate-output files mawk reads are shaped (and how the port emits).
const doc = (lines: string[]): string => toBytes(lines.map((l) => l + "\n").join(""));

describe("splitAwkRecords (awk RS='\\n' semantics)", () => {
  it("treats the empty string as ZERO records (awk NR==0)", () => {
    expect(splitAwkRecords("")).toEqual([]);
  });
  it("does not make the terminating newline an extra empty record", () => {
    expect(splitAwkRecords("a\nb\n")).toEqual(["a", "b"]);
  });
  it("keeps a final line with no trailing newline", () => {
    expect(splitAwkRecords("a\nb")).toEqual(["a", "b"]);
  });
  it("preserves interior and trailing blank records", () => {
    expect(splitAwkRecords("a\n\n")).toEqual(["a", ""]);
    expect(splitAwkRecords("\n\n")).toEqual(["", ""]);
  });
});

describe("joinAwkLines (awk print ORS='\\n' semantics)", () => {
  it("emits each record followed by a newline", () => {
    expect(joinAwkLines(["a", "b"])).toBe("a\nb\n");
  });
  it("emits nothing for an empty list (no stray newline)", () => {
    expect(joinAwkLines([])).toBe("");
  });
});

describe("isSignalLine (port of awk is_signal)", () => {
  it("matches go test, vitest/jest marks, jest block, maven, pytest, stacks", () => {
    expect(isSignalLine("--- FAIL: TestAdd (0.00s)")).toBe(true);
    expect(isSignalLine("FAILED tests/test_add.py::test_add - assert 3 == 4")).toBe(true);
    expect(isSignalLine(" FAIL  src/sum.test.ts > adds numbers")).toBe(true);
    expect(isSignalLine(toBytes("   ✕ adds numbers"))).toBe(true);
    expect(isSignalLine(toBytes("  ● Calc › adds"))).toBe(true);
    expect(isSignalLine("AssertionError: expected 3 to be 4")).toBe(true);
    expect(isSignalLine("    Received: 3")).toBe(true);
    expect(isSignalLine("[ERROR] Tests run: 1, Failures: 1 <<< FAILURE!")).toBe(true);
    expect(isSignalLine("panic: runtime error")).toBe(true);
    expect(isSignalLine("      at Object.<anonymous> (src/sum.test.js:5:19)")).toBe(true);
    expect(isSignalLine("    at com.example.CalcTest.testAdd(CalcTest.java:12)")).toBe(true);
  });
  it("does NOT match plain progress / summary-count lines", () => {
    expect(isSignalLine(" RUN  v1.6.0")).toBe(false);
    expect(isSignalLine(" Test Files  1 failed (1)")).toBe(false);
    expect(isSignalLine("Compiling module A")).toBe(false);
    expect(isSignalLine("Done in 4.2s")).toBe(false);
    // lowercase 'failed' does NOT match the case-sensitive FAIL/FAILED patterns
    // (this ASCII line carries no byte in the mark set, so it is truly non-signal)
    expect(isSignalLine(" Test Files  1 failed (1)")).toBe(false);
  });
  it("mawk BYTE semantics: [✕✗×] matches any line sharing a UTF-8 byte (e.g. ❯)", () => {
    // ❯ (E2 9D AF) shares byte 0xE2 with the marks, so the byte-oriented mawk —
    // and this faithful port — treat the vitest progress line as SIGNAL. This is
    // intentional parity, not a bug (see the vitest distill case below).
    expect(isSignalLine(toBytes(" ❯ src/sum.test.ts (1 test | 1 failed)"))).toBe(true);
    // A multibyte glyph sharing NO byte with the set stays non-signal (¿ = C2 BF).
    expect(isSignalLine(toBytes("plain ¿ prompt"))).toBe(false);
  });
});

describe("distillOutput — framework corpora (signal path, file order)", () => {
  it("go test: keeps --- FAIL, the assertion, the FAIL verdicts; drops RUN/exit", () => {
    const input = doc([
      "=== RUN   TestAdd",
      "--- FAIL: TestAdd (0.00s)",
      "    add_test.go:10: expected 4 got 3",
      "FAIL",
      "exit status 1",
      "FAIL\texample/add\t0.002s",
    ]);
    expect(distillOutput(input, 40)).toBe(
      doc([
        "--- FAIL: TestAdd (0.00s)",
        "    add_test.go:10: expected 4 got 3",
        "FAIL",
        "FAIL\texample/add\t0.002s",
      ]),
    );
  });

  it("pytest: keeps the asserts, the traceback error line, and the FAILED summary", () => {
    const input = doc([
      "    def test_add():",
      ">       assert add(1, 2) == 4",
      "E       assert 3 == 4",
      "tests/test_add.py:5: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_add.py::test_add - assert 3 == 4",
    ]);
    expect(distillOutput(input, 40)).toBe(
      doc([
        ">       assert add(1, 2) == 4",
        "E       assert 3 == 4",
        "tests/test_add.py:5: AssertionError",
        "FAILED tests/test_add.py::test_add - assert 3 == 4",
      ]),
    );
  });

  it("vitest: keeps the ❯/✕ (E2) lines, FAIL, AssertionError, stack; drops RUN and count", () => {
    const input = doc([
      " RUN  v1.6.0", //                                 ASCII, no signal → dropped
      " ❯ src/sum.test.ts (1 test | 1 failed)", //       ❯ shares 0xE2 → SIGNAL (mawk parity)
      "   ✕ adds numbers", //                             ✕ mark → signal
      " FAIL  src/sum.test.ts > adds numbers", //         FAIL → signal
      "AssertionError: expected 3 to be 4", //           AssertionError → signal
      " ❯ src/sum.test.ts:5:23", //                       ❯ + stack ref → signal
      " Test Files  1 failed (1)", //                     ASCII count line → dropped
      "      Tests  1 failed (1)", //                     ASCII count line → dropped
    ]);
    expect(distillOutput(input, 40)).toBe(
      doc([
        " ❯ src/sum.test.ts (1 test | 1 failed)",
        "   ✕ adds numbers",
        " FAIL  src/sum.test.ts > adds numbers",
        "AssertionError: expected 3 to be 4",
        " ❯ src/sum.test.ts:5:23",
      ]),
    );
  });

  it("jest: keeps FAIL, the ● block, expect/Expected/Received, and the stack", () => {
    const input = doc([
      " FAIL  src/sum.test.js",
      "  ● Calc › adds",
      "    expect(received).toBe(expected)",
      "    Expected: 4",
      "    Received: 3",
      "      at Object.<anonymous> (src/sum.test.js:5:19)",
    ]);
    // Every line carries signal → all are kept in file order.
    expect(distillOutput(input, 40)).toBe(input);
  });

  it("maven surefire: keeps [ERROR]/<<< FAILURE, the assertion, the stack frame", () => {
    const input = doc([
      "[INFO] Running com.example.CalcTest",
      "[ERROR] Tests run: 1, Failures: 1 <<< FAILURE!",
      "org.opentest4j.AssertionFailedError: expected: <4> but was: <3>",
      "\tat com.example.CalcTest.testAdd(CalcTest.java:12)",
    ]);
    expect(distillOutput(input, 40)).toBe(
      doc([
        "[ERROR] Tests run: 1, Failures: 1 <<< FAILURE!",
        "org.opentest4j.AssertionFailedError: expected: <4> but was: <3>",
        "\tat com.example.CalcTest.testAdd(CalcTest.java:12)",
      ]),
    );
  });
});

describe("distillOutput — tail fallback (no framework signal)", () => {
  it("returns the last non-blank lines when nothing matches", () => {
    const input = doc([
      "Building project...",
      "Compiling module A",
      "Compiling module B",
      "Done in 4.2s",
    ]);
    expect(distillOutput(input, 40)).toBe(input);
  });

  it("drops blank lines inside the tail window (can yield fewer than MAX)", () => {
    const input = doc(["line one", "", "line three"]);
    expect(distillOutput(input, 40)).toBe(doc(["line one", "line three"]));
  });

  it("clamps the tail window to the last MAX lines", () => {
    const input = doc(["nope1", "nope2", "nope3", "nope4", "nope5"]);
    expect(distillOutput(input, 2)).toBe(doc(["nope4", "nope5"]));
  });
});

describe("distillOutput — MAX cap and edge cases", () => {
  it("truncates signal lines to MAX, keeping file order", () => {
    const input = doc(["FAIL a", "FAIL b", "FAIL c", "FAIL d", "FAIL e"]);
    expect(distillOutput(input, 3)).toBe(doc(["FAIL a", "FAIL b", "FAIL c"]));
  });

  it("returns the empty string for empty input", () => {
    expect(distillOutput("", 40)).toBe("");
  });

  it("never emits a blank signal-window line", () => {
    // A blank line is never signal AND is explicitly filtered — the FAIL lines
    // survive, the interleaved blank does not.
    const input = doc(["FAIL first", "", "AssertionError: boom"]);
    expect(distillOutput(input, 40)).toBe(doc(["FAIL first", "AssertionError: boom"]));
  });

  it("handles input with no trailing newline the same as awk", () => {
    expect(distillOutput("FAIL a\nFAIL b", 40)).toBe("FAIL a\nFAIL b\n");
  });
});

describe("extractFailure — framed-block extraction", () => {
  it("emits nothing when there is no frame", () => {
    expect(extractFailure(doc(["GATE\ttests\trepo\tPASS\t0\tnpm test"]))).toBe("");
  });

  it("emits nothing for empty input", () => {
    expect(extractFailure("")).toBe("");
  });

  it("extracts one block: gate header (dashes stripped) + 2-space body, blanks dropped", () => {
    const input = doc([
      "GATE\ttests\tapp\tFAIL\t1\texited 1: npm test",
      "---DOD-OUTPUT tests@app---",
      "AssertionError: boom",
      "  at f.ts:1:2",
      "",
      "---END-DOD-OUTPUT---",
    ]);
    expect(extractFailure(input)).toBe(
      doc(["failing gate: tests@app", "  AssertionError: boom", "    at f.ts:1:2"]),
    );
  });

  it("extracts multiple blocks, each prefixed by its gate", () => {
    const input = doc([
      "---DOD-OUTPUT tests@app---",
      "boom one",
      "---END-DOD-OUTPUT---",
      "---DOD-OUTPUT lint@app---",
      "boom two",
      "---END-DOD-OUTPUT---",
    ]);
    expect(extractFailure(input)).toBe(
      doc(["failing gate: tests@app", "  boom one", "failing gate: lint@app", "  boom two"]),
    );
  });

  it("strips a trailing --- with optional trailing whitespace from the header", () => {
    expect(extractFailure(doc(["---DOD-OUTPUT tests@app---  ", "x", "---END-DOD-OUTPUT---"]))).toBe(
      doc(["failing gate: tests@app", "  x"]),
    );
  });

  it("leaves a header with no trailing dashes intact", () => {
    expect(extractFailure(doc(["---DOD-OUTPUT tests@app", "x", "---END-DOD-OUTPUT---"]))).toBe(
      doc(["failing gate: tests@app", "  x"]),
    );
  });

  it("ignores body lines outside any frame", () => {
    const input = doc([
      "before",
      "---DOD-OUTPUT g@r---",
      "inside",
      "---END-DOD-OUTPUT---",
      "after",
    ]);
    expect(extractFailure(input)).toBe(doc(["failing gate: g@r", "  inside"]));
  });
});
