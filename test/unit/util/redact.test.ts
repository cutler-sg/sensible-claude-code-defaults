import { afterEach, describe, expect, it } from "vitest";
import { SECRET_KEYS } from "../../../src/config/managedKeys.js";
import {
  forgetAll,
  REDACTED,
  redact,
  redactValue,
  register,
  registeredCount,
} from "../../../src/util/redact.js";

/**
 * `redact.ts` is the module hard rule 4 rests on, so it gets a suite of its own
 * rather than being covered incidentally by the consumers that call it. Every
 * test here clears the registry afterwards: it is module-level state, and a
 * value left behind would silently redact another file's fixtures.
 */
afterEach(() => {
  forgetAll();
});

/** Matches none of the PATTERNS, so only the registry can catch it. */
const UNRECOGNISED = "Zq7Xk2Mv9Tb4Rn6Wc8Jd3Fp5Hs1Ly0Gu";

describe("the registry", () => {
  it("replaces a registered value wherever it appears", () => {
    register(UNRECOGNISED);

    expect(redact(`saved ${UNRECOGNISED} and again ${UNRECOGNISED}`)).toBe(
      `saved ${REDACTED} and again ${REDACTED}`,
    );
  });

  it("leaves a value it was never told about alone", () => {
    expect(redact(`saved ${UNRECOGNISED}`)).toBe(`saved ${UNRECOGNISED}`);
  });

  it("ignores undefined, so a caller need not check first", () => {
    register(undefined);

    expect(registeredCount()).toBe(0);
  });

  it("registers the trimmed value, so a stored newline cannot hide the core", () => {
    register(`  ${UNRECOGNISED}\n`);

    expect(redact(`token=${UNRECOGNISED}`)).toBe(`token=${REDACTED}`);
  });

  it("refuses a value too short to be a credential rather than a coincidence", () => {
    register("abc");
    register("1234567");

    expect(registeredCount()).toBe(0);
    expect(redact("abc 1234567")).toBe("abc 1234567");
  });

  it("accepts a value exactly at the length floor", () => {
    register("12345678");

    expect(registeredCount()).toBe(1);
    expect(redact("x12345678y")).toBe(`x${REDACTED}y`);
  });

  it("holds one entry per distinct value", () => {
    register(UNRECOGNISED);
    register(UNRECOGNISED);
    register(`${UNRECOGNISED}2`);

    expect(registeredCount()).toBe(2);
  });

  /**
   * The rotation case, structurally. A previous token that is a prefix of the
   * new one must not be replaced first: doing so would cut the longer value in
   * half and leave its tail readable.
   */
  it("replaces the longest match first", () => {
    const short = "TOKENPREFIX0";
    const long = `${short}ANDMORESECRET`;
    register(short);
    register(long);

    const out = redact(`old=${short} new=${long}`);

    expect(out).toBe(`old=${REDACTED} new=${REDACTED}`);
    expect(out).not.toContain("ANDMORE");
  });

  it("forgets everything on demand", () => {
    register(UNRECOGNISED);
    forgetAll();

    expect(registeredCount()).toBe(0);
    expect(redact(UNRECOGNISED)).toBe(UNRECOGNISED);
  });
});

describe("the pattern net", () => {
  it.each([
    ["an access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a session key id", "ASIAIOSFODNN7EXAMPLE"],
    ["a long-term Bedrock key", "ABSKQmVkcm9ja0FQSUtleVZhbHVl"],
    ["a short-term Bedrock key", "bedrock-api-key-QmVkcm9ja1Nob3J0"],
  ])("catches %s we never held", (_name, secret) => {
    expect(redact(`value: ${secret} end`)).toBe(`value: ${REDACTED} end`);
  });

  it("catches a bearer header in either case", () => {
    expect(redact("Authorization: Bearer abc.def")).toBe(REDACTED);
    expect(redact("authorization : Bearer abc.def")).toBe(REDACTED);
  });

  it("catches the token key quoted back out of a settings document", () => {
    expect(redact('  "AWS_BEARER_TOKEN_BEDROCK": "whatever-is-in-there",')).toBe(`  ${REDACTED},`);
  });

  it("leaves ordinary prose alone", () => {
    const line = 'Health check: {"pass":12,"info":1,"warning":0,"error":0,"skipped":5}';

    expect(redact(line)).toBe(line);
  });

  /**
   * Each pattern is a module-level literal carrying the `g` flag, so a stale
   * `lastIndex` would make the second call on an identical line miss.
   */
  it("gives the same answer twice in a row", () => {
    const line = "key AKIAIOSFODNN7EXAMPLE and ABSKQmVkcm9ja0FQSUtleVZhbHVl";

    expect(redact(line)).toBe(redact(line));
    expect(redact(line)).toBe(`key ${REDACTED} and ${REDACTED}`);
  });

  /**
   * Every pattern is anchored on a literal prefix or key name with no nested
   * quantifier, so a long non-matching line cannot blow the stack or spin.
   * Asserted rather than assumed: a log line is attacker-influenced whenever a
   * settings file is.
   */
  it("stays linear on a 100 KiB line", () => {
    register(UNRECOGNISED);
    const line = `${"AB".repeat(50_000)}${UNRECOGNISED}`;

    const started = Date.now();
    const out = redact(line);

    expect(out.endsWith(REDACTED)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("redactValue", () => {
  /**
   * The walker compares each own key against the set it is given, and the keys
   * it sees are leaf names — so `SECRET_KEYS`, whose entries are dotted managed
   * keys, matches nothing on its own. `report.ts` passes the leaf names; this
   * pins the behaviour so that translation cannot be dropped by accident.
   */
  const LEAVES: ReadonlySet<string> = new Set(
    [...SECRET_KEYS].map((key) => key.slice(key.lastIndexOf(".") + 1)),
  );

  it("redacts by key, wherever the key is nested", () => {
    const out = redactValue({ env: { AWS_BEARER_TOKEN_BEDROCK: UNRECOGNISED } }, LEAVES);

    expect(out).toEqual({ env: { AWS_BEARER_TOKEN_BEDROCK: REDACTED } });
  });

  it("redacts by key even for a value that is not a string", () => {
    const out = redactValue({ AWS_BEARER_TOKEN_BEDROCK: { nested: 1 } }, LEAVES);

    expect(out).toEqual({ AWS_BEARER_TOKEN_BEDROCK: REDACTED });
  });

  it("redacts by value under a key it does not know", () => {
    register(UNRECOGNISED);

    expect(redactValue({ notes: `key is ${UNRECOGNISED}` }, LEAVES)).toEqual({
      notes: `key is ${REDACTED}`,
    });
  });

  it("walks arrays", () => {
    register(UNRECOGNISED);

    expect(redactValue([UNRECOGNISED, { AWS_BEARER_TOKEN_BEDROCK: "x" }], LEAVES)).toEqual([
      REDACTED,
      { AWS_BEARER_TOKEN_BEDROCK: REDACTED },
    ]);
  });

  it("passes non-string primitives through untouched", () => {
    expect(redactValue({ n: 1, b: true, z: null }, LEAVES)).toEqual({ n: 1, b: true, z: null });
    expect(redactValue(42, LEAVES)).toBe(42);
    expect(redactValue(undefined, LEAVES)).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const input = { env: { AWS_BEARER_TOKEN_BEDROCK: UNRECOGNISED } };

    redactValue(input, LEAVES);

    expect(input.env.AWS_BEARER_TOKEN_BEDROCK).toBe(UNRECOGNISED);
  });

  /**
   * A settings document is user data, so its keys can be anything — including
   * `__proto__`. `redactValue` assigns rather than defines, so such a key is
   * sent to the returned object's prototype and vanishes from the serialised
   * output instead of appearing in it (`managedKeys.setPath` avoids this by
   * defining the key; see the M5 report for the gap).
   *
   * That is a fidelity loss, not a disclosure, and this pins the half that
   * matters: the subtree is redacted on the way past, so whichever way the
   * assignment lands, nothing readable survives it — and `Object.prototype` is
   * untouched, so the pollution cannot reach any other object.
   */
  it("keeps a __proto__ key in the report instead of losing it to the prototype", () => {
    register(UNRECOGNISED);
    const parsed = JSON.parse(
      `{"a":1,"__proto__":{"AWS_BEARER_TOKEN_BEDROCK":"x","note":"${UNRECOGNISED}"}}`,
    ) as unknown;

    const out = redactValue(parsed, LEAVES) as Record<string, unknown>;
    const rendered = JSON.stringify(out);

    // Redacted, and still *there*: assigning would have set the prototype, so
    // the entry would vanish from the report the user is pasting for help.
    expect(rendered).not.toContain(UNRECOGNISED);
    expect(rendered).toContain("__proto__");
    expect(rendered).toContain(REDACTED);
    expect(rendered).toContain('"a":1');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it("matches a dotted secret key as well as a bare leaf name", () => {
    const out = redactValue(
      { env: { AWS_BEARER_TOKEN_BEDROCK: "hand-pasted-unknown-shape" } },
      new Set(["env.AWS_BEARER_TOKEN_BEDROCK"]),
    );

    // SECRET_KEYS is dotted; a caller handing it over unchanged must not
    // silently fall back to the pattern net alone.
    expect(JSON.stringify(out)).not.toContain("hand-pasted");
    expect(JSON.stringify(out)).toContain(REDACTED);
  });
});

/**
 * A settings document's keys are unconstrained user data, and a transposed
 * key/value is an ordinary hand-editing mistake — so a key is as capable of
 * carrying the token as a value is. `redactValue` walking values only meant
 * that the one place `redact` could not reach was the one place a key/value
 * swap puts the secret.
 */
describe("redactValue over object keys", () => {
  const LEAVES: ReadonlySet<string> = new Set(
    [...SECRET_KEYS].map((key) => key.slice(key.lastIndexOf(".") + 1)),
  );

  it("redacts a registered secret that appears as a key", () => {
    register(UNRECOGNISED);

    const out = redactValue({ env: { [UNRECOGNISED]: "AWS_BEARER_TOKEN_BEDROCK" } }, LEAVES);

    expect(JSON.stringify(out)).not.toContain(UNRECOGNISED);
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  /**
   * The transposition in full: the value is the key name and the key is the
   * key. `redact()` on the same text as a string would have caught this, so a
   * walker that skips keys is strictly weaker than not walking at all.
   */
  it("catches a key the pattern net recognises, with an empty registry", () => {
    const pasted = "ABSKQmVkcm9ja0FQSUtleVZhbHVl";

    const out = redactValue(
      JSON.parse(`{"env":{"${pasted}":"AWS_BEARER_TOKEN_BEDROCK"}}`) as unknown,
      LEAVES,
    );

    expect(JSON.stringify(out)).not.toContain(pasted);
  });

  /**
   * The one key that must survive verbatim: redacting it too would leave a row
   * of two «redacted»s, and the reader could no longer tell which setting was
   * removed.
   */
  it("keeps a secret key's own name so the row stays identifiable", () => {
    expect(redactValue({ env: { AWS_BEARER_TOKEN_BEDROCK: "x" } }, LEAVES)).toEqual({
      env: { AWS_BEARER_TOKEN_BEDROCK: REDACTED },
    });
  });

  it("leaves an ordinary key alone", () => {
    register(UNRECOGNISED);

    expect(redactValue({ model: "sonnet", n: 1 }, LEAVES)).toEqual({ model: "sonnet", n: 1 });
  });
});
