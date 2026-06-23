import { describe, expect, it } from "vitest";

import { assertSafeBind, isLoopbackHost } from "../src/api/server.js";
import { DispatchError } from "../src/util/errors.js";

/**
 * The REST API ships without auth/RBAC, so binding it to a non-loopback host
 * must refuse to start unless the operator explicitly opts in. These exercise
 * the pure guard — no sockets are opened.
 */
describe("assertSafeBind", () => {
  it("allows loopback IPv4 with no opt-in", () => {
    expect(() => assertSafeBind("127.0.0.1", false)).not.toThrow();
  });

  it("allows loopback IPv6 and localhost with no opt-in", () => {
    expect(() => assertSafeBind("::1", false)).not.toThrow();
    expect(() => assertSafeBind("[::1]", false)).not.toThrow();
    expect(() => assertSafeBind("localhost", false)).not.toThrow();
    expect(() => assertSafeBind("LOCALHOST", false)).not.toThrow();
  });

  it("refuses 0.0.0.0 without the opt-in", () => {
    expect(() => assertSafeBind("0.0.0.0", false)).toThrow(DispatchError);
  });

  it("throws a structured UNSAFE_BIND error that explains the risk and override", () => {
    try {
      assertSafeBind("0.0.0.0", false);
      expect.unreachable("expected assertSafeBind to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const wgErr = err as DispatchError;
      expect(wgErr.code).toBe("UNSAFE_BIND");
      expect(wgErr.details).toMatchObject({ host: "0.0.0.0" });
      // Message names the risk (no auth) and both override mechanisms.
      expect(wgErr.message).toMatch(/no authentication/i);
      expect(wgErr.message).toContain("--unsafe-bind");
      expect(wgErr.message).toContain("DISPATCH_UNSAFE_BIND=1");
    }
  });

  it("refuses an arbitrary public/LAN host without the opt-in", () => {
    expect(() => assertSafeBind("::", false)).toThrow(DispatchError);
    expect(() => assertSafeBind("0.0.0.0", false)).toThrow(/UNSAFE_BIND|non-loopback/i);
    expect(() => assertSafeBind("192.168.1.50", false)).toThrow(DispatchError);
  });

  it("allows a non-loopback host when the flag opt-in is given", () => {
    expect(() => assertSafeBind("0.0.0.0", true)).not.toThrow();
    expect(() => assertSafeBind("192.168.1.50", true)).not.toThrow();
  });
});

describe("isLoopbackHost", () => {
  it("recognises the loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("  localhost  ")).toBe(true);
  });

  it("rejects wildcard and remote hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});
