import type { Dispatch } from "../../src/core.js";
import type { Actor } from "../../src/domain/types.js";
import type { PrincipalView } from "../../src/repositories/principalRepository.js";

/**
 * A PERSON'S TESTER VERDICT (package H1) needs an active human or admin principal. The
 * one helper every dispatch test uses to record a person's PASS (a waiver) or FAIL: it
 * mints (once per actor) the principal that speaks for `actor` and returns the authority
 * argument the verdict takes, plus the principal and its token for CLI/REST callers.
 */
export function principalFor(
  wg: Dispatch,
  actor: Actor,
): { principal: PrincipalView; token: string; authority: { principal: PrincipalView } } {
  if (actor.type !== "human" && actor.type !== "admin") {
    throw new Error(`principalFor: ${actor.type} is not a person`);
  }
  const id = actor.id ?? "operator";
  const name = `${actor.type}-${id}`.replace(/[^A-Za-z0-9._@-]/g, "-").slice(0, 64);
  const known = tokens.get(wg)?.get(name);
  if (known) return known;
  const { principal, token } = wg.createPrincipal(
    { name, actorType: actor.type, actorId: id },
    { type: "human", id: "operator" },
  );
  const out = { principal, token, authority: { principal } };
  if (!tokens.has(wg)) tokens.set(wg, new Map());
  tokens.get(wg)!.set(name, out);
  return out;
}

/** The authority argument alone: `wg.testerPass(id, input, human, asPerson(wg, human))`. */
export function asPerson(wg: Dispatch, actor: Actor): { principal: PrincipalView } {
  return principalFor(wg, actor).authority;
}

const tokens = new WeakMap<
  Dispatch,
  Map<string, { principal: PrincipalView; token: string; authority: { principal: PrincipalView } }>
>();
