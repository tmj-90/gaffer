// @vitest-environment jsdom
//
// The shared number formats and the two statistics helpers every view uses (dashboard
// visual pass, package P2): one duration format (fmtDuration; fmtWait is its deprecated
// alias), one money format (never four decimals), one percent format ("2.5%", the sign
// part of the value, whole numbers at 10 and above), the Wilson 95% interval for a rate
// and the period-over-period delta that hides itself below a minimum sample.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web/js");
const load = (f: string) =>
  import(`${pathToFileURL(path.join(WEB, f)).href}?t=${Date.now()}-${Math.random()}`);

let fmt: any;
let stats: any;
beforeAll(async () => {
  fmt = await load("format.js");
  stats = await load("stats.js");
});

describe("format: one duration, one money, one percent", () => {
  it("fmtDuration: days, hours, minutes, seconds; a dash for nothing", () => {
    const H = 3_600_000;
    expect(fmt.fmtDuration(2 * 24 * H + 3 * H)).toBe("2d 3h");
    expect(fmt.fmtDuration(9 * H + 16 * 60_000)).toBe("9h 16m");
    expect(fmt.fmtDuration(45 * 60_000)).toBe("45m");
    expect(fmt.fmtDuration(12_000)).toBe("12s");
    expect(fmt.fmtDuration(null)).toBe("\u2014");
  });

  it("fmtWait is a deprecated alias of fmtDuration (no more '9 h 16 min')", () => {
    expect(typeof fmt.fmtWait).toBe("function");
    const ms = 9 * 3_600_000 + 16 * 60_000;
    expect(fmt.fmtWait(ms)).toBe(fmt.fmtDuration(ms));
    expect(fmt.fmtWait(23 * 86_400_000 + 9 * 3_600_000)).toBe("23d 9h");
  });

  it("money never prints four decimals", () => {
    expect(fmt.money(0.0321)).toBe("$0.03");
    expect(fmt.money(0.0034)).toBe("<$0.01");
    expect(fmt.money(0.95)).toBe("$0.95");
    expect(fmt.moneyW(25)).toBe("$25");
    expect(fmt.money(null)).toBe("\u2014");
  });

  it("pct: '%' is part of the value; whole at 10 and above, one decimal below", () => {
    expect(fmt.pct(2.5)).toBe("2.5%");
    expect(fmt.pct(96.2)).toBe("96%");
    expect(fmt.pct(10)).toBe("10%");
    expect(fmt.pct(9.96)).toBe("10%");
    expect(fmt.pct(5)).toBe("5%");
    expect(fmt.pct(0)).toBe("0%");
    expect(fmt.pct(0.04)).toBe("<0.1%");
    expect(fmt.pct(96.25, { decimals: 1 })).toBe("96.3%");
    expect(fmt.pct(null)).toBe("\u2014");
    expect(fmt.pct(Number.NaN)).toBe("\u2014");
    expect(fmt.pct(2.5)).not.toMatch(/\s%/);
  });
});

describe("stats: wilson and delta (pure)", () => {
  it("wilson(4, 4) is about 51% to 100% (the audit's small-sample example)", () => {
    const w = stats.wilson(4, 4);
    expect(w.lo).toBeCloseTo(0.51, 2);
    expect(w.hi).toBeCloseTo(1, 5);
  });

  it("wilson(0, 11) has a lower bound of 0 and an upper bound near 26%", () => {
    const w = stats.wilson(0, 11);
    expect(w.lo).toBe(0);
    expect(w.hi).toBeCloseTo(0.2588, 3);
  });

  it("wilson narrows with n and honours z", () => {
    const a = stats.wilson(5, 10);
    const b = stats.wilson(50, 100);
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
    const z1 = stats.wilson(5, 10, 1);
    expect(z1.hi - z1.lo).toBeLessThan(a.hi - a.lo);
  });

  it("wilson answers null for no sample", () => {
    expect(stats.wilson(0, 0)).toBeNull();
    expect(stats.wilson(1, null)).toBeNull();
  });

  it("delta: direction and verdict follow goodWhen", () => {
    expect(stats.delta(90, 80, { goodWhen: "up" })).toEqual({
      value: 10,
      direction: "up",
      verdict: "better",
    });
    expect(stats.delta(90, 80, { goodWhen: "down" })).toMatchObject({
      direction: "up",
      verdict: "worse",
    });
    expect(stats.delta(5, 5, { goodWhen: "down" })).toMatchObject({
      value: 0,
      direction: "flat",
      verdict: "same",
    });
  });

  it("delta: hidden below minN in either period, and when a value is missing", () => {
    const small = stats.delta({ value: 100, n: 4 }, { value: 50, n: 20 }, { minN: 10 });
    expect(small).toMatchObject({ value: null, verdict: null, reason: "too few" });
    const prevSmall = stats.delta({ value: 100, n: 40 }, { value: 50, n: 9 }, { minN: 10 });
    expect(prevSmall.verdict).toBeNull();
    const ok = stats.delta({ value: 100, n: 40 }, { value: 50, n: 10 }, { minN: 10 });
    expect(ok).toMatchObject({ value: 50, direction: "up", verdict: "better" });
    expect(stats.delta(null, 4)).toMatchObject({ value: null, verdict: null });
  });
});
