import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsPath } from "../../../src/config/paths.js";
import { MemorySnapshotStore } from "../../../src/config/snapshot.js";
import {
  ageInDays,
  ageLevel,
  CorruptTokenSecretError,
  MemoryTokenStore,
  SecretTokenStore,
} from "../../../src/credential/store.js";
import {
  type SecretStorageLike,
  type StoredToken,
  TOKEN_SECRET_KEY,
} from "../../../src/credential/types.js";
import { readTokenFromSettings } from "../../../src/credential/writeThrough.js";
import type { CredentialPolicy } from "../../../src/manifest/types.js";
import { forgetAll, REDACTED, redact, registeredCount } from "../../../src/util/redact.js";

const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";

/** Map-backed SecretStorage with an arming point for keychain failures. */
class FakeSecrets implements SecretStorageLike {
  readonly values = new Map<string, string>();
  readonly calls: string[] = [];
  failure: Error | undefined;

  get(key: string): Promise<string | undefined> {
    this.calls.push(`get:${key}`);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.calls.push(`store:${key}`);
    if (this.failure) return Promise.reject(this.failure);
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    if (this.failure) return Promise.reject(this.failure);
    this.values.delete(key);
    return Promise.resolve();
  }
}

const NOW = new Date("2026-09-10T12:00:00.000Z");

let secrets: FakeSecrets;
let store: SecretTokenStore;

beforeEach(() => {
  secrets = new FakeSecrets();
  store = new SecretTokenStore(secrets, { now: () => NOW });
  forgetAll();
});

// The registry is module-level state, so a value left behind by one test would
// scrub another's fixtures and make an assertion pass for the wrong reason.
afterEach(() => {
  forgetAll();
});

describe("SecretTokenStore", () => {
  it("round-trips a stored token", async () => {
    await store.set({ token: TOKEN, setAt: "2026-01-01T00:00:00.000Z" });
    await expect(store.get()).resolves.toEqual({
      token: TOKEN,
      setAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("stores exactly one JSON secret under the documented key", async () => {
    await store.set({ token: TOKEN, setAt: NOW.toISOString() });
    expect([...secrets.values.keys()]).toEqual([TOKEN_SECRET_KEY]);
    expect(JSON.parse(secrets.values.get(TOKEN_SECRET_KEY) ?? "")).toEqual({
      token: TOKEN,
      setAt: NOW.toISOString(),
    });
  });

  it("reports an absent secret as undefined", async () => {
    await expect(store.get()).resolves.toBeUndefined();
  });

  it("clears the secret", async () => {
    await store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await store.clear();
    expect(secrets.values.size).toBe(0);
    await expect(store.get()).resolves.toBeUndefined();
  });

  it("stamps a token from the injected clock", () => {
    expect(store.stamp(TOKEN)).toEqual({ token: TOKEN, setAt: NOW.toISOString() });
  });

  /**
   * F7. A secret we cannot read is never deleted.
   *
   * `get` runs before the user has clicked anything — the activation path pushes
   * the token into the terminal collection — so a delete here destroys a key
   * with no consent, no confirmation and no copy anywhere. The shape rules are
   * documented as permissive precisely because they cannot tell a real key from
   * an odd-looking one, which makes them the wrong thing to hang a deletion on.
   * So: a secret that might hold a key is kept and reported; a secret that
   * cannot hold one reads as absent and is still kept.
   */
  describe("a secret that cannot be parsed", () => {
    /** Every branch below must leave the secret exactly as it found it. */
    function expectKept(raw: string): void {
      expect(secrets.values.get(TOKEN_SECRET_KEY)).toBe(raw);
      expect(secrets.calls).not.toContain(`delete:${TOKEN_SECRET_KEY}`);
    }

    it("reports unparseable JSON rather than deleting it", async () => {
      // Not JSON, and the whitespace inside rules it out as a token too — but
      // it is still a string that might have held one.
      secrets.values.set(TOKEN_SECRET_KEY, "{not json");
      await expect(store.get()).rejects.toThrow(CorruptTokenSecretError);
      expectKept("{not json");
    });

    it("names no part of the secret in the error it throws (hard rule 4)", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, `{not json ${TOKEN}`);
      await expect(store.get()).rejects.toThrow(/can't be read/);
      const error = await store.get().catch((thrown: Error) => thrown);
      expect((error as Error).message).not.toContain(TOKEN.slice(0, 6));
    });

    it("reports a JSON value that is not an object as absent, and keeps it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, "[1,2,3]");
      await expect(store.get()).resolves.toBeUndefined();
      expectKept("[1,2,3]");
    });

    it("reports an object with no token as absent, and keeps it", async () => {
      const raw = JSON.stringify({ setAt: NOW.toISOString() });
      secrets.values.set(TOKEN_SECRET_KEY, raw);
      await expect(store.get()).resolves.toBeUndefined();
      expectKept(raw);
    });

    it("reports an empty-string token as absent, and keeps it", async () => {
      const raw = JSON.stringify({ token: "", setAt: "x" });
      secrets.values.set(TOKEN_SECRET_KEY, raw);
      await expect(store.get()).resolves.toBeUndefined();
      expectKept(raw);
    });

    it("reports an empty JSON string as absent, and keeps it", async () => {
      const raw = JSON.stringify("  ");
      secrets.values.set(TOKEN_SECRET_KEY, raw);
      await expect(store.get()).resolves.toBeUndefined();
      expectKept(raw);
    });

    it("reports an empty raw secret as absent, and keeps it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, "   ");
      await expect(store.get()).resolves.toBeUndefined();
      expectKept("   ");
    });

    it("keeps a token whose setAt is missing, losing only the age", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify({ token: TOKEN }));
      await expect(store.get()).resolves.toEqual({ token: TOKEN, setAt: "" });
    });

    it("keeps a token whose setAt is not a string", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify({ token: TOKEN, setAt: 17 }));
      await expect(store.get()).resolves.toEqual({ token: TOKEN, setAt: "" });
    });
  });

  describe("legacy bare-string secrets", () => {
    it("migrates a JSON string to the current shape and re-stores it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify(TOKEN));
      await expect(store.get()).resolves.toEqual({ token: TOKEN, setAt: NOW.toISOString() });
      expect(JSON.parse(secrets.values.get(TOKEN_SECRET_KEY) ?? "")).toEqual({
        token: TOKEN,
        setAt: NOW.toISOString(),
      });
    });

    it("migrates a raw unquoted token", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, TOKEN);
      await expect(store.get()).resolves.toEqual({ token: TOKEN, setAt: NOW.toISOString() });
      expect(secrets.calls).toContain(`store:${TOKEN_SECRET_KEY}`);
    });

    /**
     * F7 again, on the branch that made the deletion so damaging: `asLegacy`
     * calls the permissive shape rules, and a real long-term key that happens
     * to look like an IAM secret access key would have been destroyed on the
     * first read. Both spellings of a bare secret are covered — a raw one and a
     * JSON-quoted one — because they take different routes through `parse`.
     */
    it.each([
      ["a raw access key id", (value: string) => value],
      ["a JSON-quoted access key id", (value: string) => JSON.stringify(value)],
    ])("keeps %s rather than destroying it", async (_name, encode) => {
      const raw = encode("AKIAIOSFODNN7EXAMPLE");
      secrets.values.set(TOKEN_SECRET_KEY, raw);
      await expect(store.get()).rejects.toThrow(CorruptTokenSecretError);
      expect(secrets.values.get(TOKEN_SECRET_KEY)).toBe(raw);
    });

    it("keeps a bare string shaped like a secret access key", async () => {
      // Forty base64 characters: the shape rules call this an IAM secret, but
      // AWS does not document the key format, so they cannot be sure enough to
      // delete it.
      const raw = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12";
      secrets.values.set(TOKEN_SECRET_KEY, raw);
      await expect(store.get()).rejects.toThrow(CorruptTokenSecretError);
      expect(secrets.values.get(TOKEN_SECRET_KEY)).toBe(raw);
    });

    it("trims a legacy value before migrating it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, `\n${TOKEN}\n`);
      await expect(store.get()).resolves.toEqual({ token: TOKEN, setAt: NOW.toISOString() });
    });

    it("returns the migrated value on the next read without re-storing", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, TOKEN);
      await store.get();
      const before = secrets.calls.filter((c) => c.startsWith("store:")).length;
      await store.get();
      expect(secrets.calls.filter((c) => c.startsWith("store:")).length).toBe(before);
    });
  });

  describe("keychain unavailable (plan Q-X: report, never degrade)", () => {
    const boom = new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");

    it("propagates a get failure", async () => {
      secrets.failure = boom;
      await expect(store.get()).rejects.toThrow(boom);
    });

    it("propagates a set failure", async () => {
      secrets.failure = boom;
      await expect(store.set({ token: TOKEN, setAt: NOW.toISOString() })).rejects.toThrow(boom);
    });

    it("propagates a clear failure", async () => {
      secrets.failure = boom;
      await expect(store.clear()).rejects.toThrow(boom);
    });
  });

  it("defaults to the wall clock when no clock is injected", async () => {
    const before = Date.now();
    const stamped = new SecretTokenStore(secrets).stamp(TOKEN);
    expect(Date.parse(stamped.setAt)).toBeGreaterThanOrEqual(before);
  });
});

/**
 * FR-4.9 wiring. The store is the door every token value comes through, so it
 * is where the redaction registry is fed — registering at each call site
 * instead would mean each new call site is a chance to forget.
 */
describe("the redaction registry (FR-4.9)", () => {
  /**
   * Values no pattern in `redact.ts` recognises, so every assertion below is
   * about the registry rather than about the pattern net catching an `ABSK`
   * prefix on its own. That is the half that carries the guarantee: AWS does
   * not document the key format, so a pattern only ever knows the shapes we
   * happened to have seen.
   */
  const NEW_KEY = "Zq7Xk2Mv9Tb4Rn6Wc8Jd3Fp5Hs1Ly0Gu";
  const OLD_KEY = "Pw4Nb8Kt2Vx6Lm0Cq5Ry9Df3Jh7Sz1Ae";

  it("registers a token as it is stored", async () => {
    await store.set({ token: NEW_KEY, setAt: NOW.toISOString() });

    expect(redact(`writing ${NEW_KEY} to the file`)).toBe(`writing ${REDACTED} to the file`);
  });

  it("registers a token as it is read", async () => {
    secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify({ token: NEW_KEY, setAt: "" }));
    forgetAll();

    await store.get();

    expect(redact(NEW_KEY)).toBe(REDACTED);
  });

  it("registers a legacy bare string as it is migrated", async () => {
    secrets.values.set(TOKEN_SECRET_KEY, NEW_KEY);
    forgetAll();

    await store.get();

    expect(redact(NEW_KEY)).toBe(REDACTED);
  });

  /**
   * The rotation case, which is the one a registry keyed only on the current
   * value gets wrong: the replaced key stays loggable for the rest of the
   * window, and it is exactly the value most likely to be sitting in a stale
   * log line or a settings file we are about to quote back.
   */
  it("leaves neither the old nor the new value loggable after a rotation", async () => {
    await store.set({ token: OLD_KEY, setAt: "2026-01-01T00:00:00.000Z" });
    // Cleared so the assertion cannot pass on the registration `set` made for
    // the *old* key on its own way in — only the rotation can put it back.
    forgetAll();
    expect(redact(OLD_KEY)).toBe(OLD_KEY);

    await store.set({ token: NEW_KEY, setAt: NOW.toISOString() });

    expect(redact(`old=${OLD_KEY} new=${NEW_KEY}`)).toBe(`old=${REDACTED} new=${REDACTED}`);
  });

  it("registers a previous value stored in the legacy bare-string shape", async () => {
    secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify(OLD_KEY));
    forgetAll();

    await store.set({ token: NEW_KEY, setAt: NOW.toISOString() });

    expect(redact(`old=${OLD_KEY}`)).toBe(`old=${REDACTED}`);
  });

  it("still stores the new value when the previous one cannot be read", async () => {
    // A keychain that refuses the read must not block a rotation: what is lost
    // is the ability to scrub a value we never saw, which is the same position
    // we are in on a machine where the key was pasted in by hand.
    const failing: SecretStorageLike = {
      get: () => Promise.reject(new Error("keychain locked")),
      store: (key, value) => {
        secrets.values.set(key, value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };

    await new SecretTokenStore(failing).set({ token: NEW_KEY, setAt: NOW.toISOString() });

    expect(secrets.values.get(TOKEN_SECRET_KEY)).toContain(NEW_KEY);
    expect(redact(NEW_KEY)).toBe(REDACTED);
  });

  it("registers nothing for a secret that holds no token", async () => {
    secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify({ notes: "nothing here" }));
    forgetAll();

    await store.get();

    expect(registeredCount()).toBe(0);
  });

  /**
   * The in-memory double registers exactly as the real store does. Without
   * that, a leak test using it would pass because the registry happened to be
   * empty — the one way these tests can be wrong.
   */
  it("is fed by the in-memory store too, previous value included", async () => {
    const memory = new MemoryTokenStore({ token: OLD_KEY, setAt: NOW.toISOString() });
    forgetAll();

    await memory.set({ token: NEW_KEY, setAt: NOW.toISOString() });

    expect(redact(`old=${OLD_KEY} new=${NEW_KEY}`)).toBe(`old=${REDACTED} new=${REDACTED}`);
  });

  it("is fed by a read of the token in the settings file", async () => {
    // The file is the other door, and the one behind `/setup-bedrock` and every
    // hand-edit — values the keychain has never held.
    const dir = await mkdtemp(join(tmpdir(), "scd-store-"));
    try {
      await writeFile(
        settingsPath(dir),
        JSON.stringify({ env: { AWS_BEARER_TOKEN_BEDROCK: NEW_KEY } }),
        "utf8",
      );
      forgetAll();

      await readTokenFromSettings({
        claudeDir: dir,
        workspaceFolders: [],
        snapshotStore: new MemorySnapshotStore(),
        platform: process.platform,
      });

      expect(redact(NEW_KEY)).toBe(REDACTED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MemoryTokenStore", () => {
  it("starts empty and round-trips", async () => {
    const memory = new MemoryTokenStore();
    await expect(memory.get()).resolves.toBeUndefined();
    await memory.set({ token: TOKEN, setAt: NOW.toISOString() });
    await expect(memory.get()).resolves.toEqual({ token: TOKEN, setAt: NOW.toISOString() });
    await memory.clear();
    await expect(memory.get()).resolves.toBeUndefined();
  });

  it("accepts an initial value and hands out copies", async () => {
    const initial: StoredToken = { token: TOKEN, setAt: NOW.toISOString() };
    const memory = new MemoryTokenStore(initial);
    const read = await memory.get();
    expect(read).toEqual(initial);
    expect(read).not.toBe(initial);
  });
});

const POLICY: CredentialPolicy = {
  warnAfterDays: 90,
  failAfterDays: 180,
  consoleUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
};

function daysAgo(days: number): StoredToken {
  return { token: TOKEN, setAt: new Date(NOW.getTime() - days * 86_400_000).toISOString() };
}

describe("ageInDays", () => {
  it("counts whole days", () => {
    expect(ageInDays(daysAgo(91), NOW)).toBe(91);
  });

  it("rounds a partial day down", () => {
    const stored = { token: TOKEN, setAt: new Date(NOW.getTime() - 90_000).toISOString() };
    expect(ageInDays(stored, NOW)).toBe(0);
  });

  it("is undefined when the stamp is unparseable", () => {
    expect(ageInDays({ token: TOKEN, setAt: "" }, NOW)).toBeUndefined();
    expect(ageInDays({ token: TOKEN, setAt: "yesterday" }, NOW)).toBeUndefined();
  });

  it("returns a negative number for a stamp in the future", () => {
    expect(ageInDays(daysAgo(-5), NOW)).toBe(-5);
  });
});

describe("ageLevel", () => {
  it("is ok below the warn threshold", () => {
    expect(ageLevel(daysAgo(89), POLICY, NOW)).toBe("ok");
  });

  it("warns at the warn threshold", () => {
    expect(ageLevel(daysAgo(90), POLICY, NOW)).toBe("warn");
  });

  it("still warns just below the fail threshold", () => {
    expect(ageLevel(daysAgo(179), POLICY, NOW)).toBe("warn");
  });

  it("fails at the fail threshold", () => {
    expect(ageLevel(daysAgo(180), POLICY, NOW)).toBe("fail");
  });

  it("reports ok when the stamp is unreadable rather than inventing an age", () => {
    expect(ageLevel({ token: TOKEN, setAt: "" }, POLICY, NOW)).toBe("ok");
  });

  it("lets fail win when a manifest sets fail below warn", () => {
    const inverted: CredentialPolicy = { ...POLICY, warnAfterDays: 200, failAfterDays: 10 };
    expect(ageLevel(daysAgo(30), inverted, NOW)).toBe("fail");
  });
});
