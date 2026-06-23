import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { authConfigured, isAuthorized } from "../src/api/auth.js";
import { assertSafeBind } from "../src/api/server.js";

/** Minimal request stub carrying only the Authorization header isAuthorized reads. */
function reqWith(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

describe("api bearer-token auth", () => {
  const original = process.env.DISPATCH_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = original;
  });

  it("disables auth when no token is configured (backwards-compatible)", () => {
    delete process.env.DISPATCH_API_TOKEN;
    expect(authConfigured()).toBe(false);
    expect(isAuthorized(reqWith())).toBe(true);
    expect(isAuthorized(reqWith("Bearer anything"))).toBe(true);
  });

  it("accepts a correct bearer token (scheme case-insensitive)", () => {
    process.env.DISPATCH_API_TOKEN = "s3cret-token";
    expect(authConfigured()).toBe(true);
    expect(isAuthorized(reqWith("Bearer s3cret-token"))).toBe(true);
    expect(isAuthorized(reqWith("bearer s3cret-token"))).toBe(true);
  });

  it("rejects missing, schemeless, wrong, or empty tokens", () => {
    process.env.DISPATCH_API_TOKEN = "s3cret-token";
    expect(isAuthorized(reqWith())).toBe(false);
    expect(isAuthorized(reqWith("s3cret-token"))).toBe(false); // no Bearer scheme
    expect(isAuthorized(reqWith("Bearer wrong"))).toBe(false);
    expect(isAuthorized(reqWith("Bearer "))).toBe(false);
  });

  it("ignores surrounding whitespace in the configured token", () => {
    process.env.DISPATCH_API_TOKEN = "  padded-token  ";
    expect(isAuthorized(reqWith("Bearer padded-token"))).toBe(true);
    expect(isAuthorized(reqWith("Bearer  padded-token "))).toBe(true);
  });
});

describe("assertSafeBind with token auth", () => {
  it("allows a non-loopback bind when a token is configured", () => {
    expect(() => assertSafeBind("192.168.4.22", false, true)).not.toThrow();
  });

  it("still refuses a non-loopback bind with no token and no opt-in", () => {
    expect(() => assertSafeBind("192.168.4.22", false, false)).toThrow();
  });
});
