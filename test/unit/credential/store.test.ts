import { beforeEach, describe, expect, it } from "vitest";
import {
  ageInDays,
  ageLevel,
  MemoryTokenStore,
  SecretTokenStore,
} from "../../../src/credential/store.js";
import {
  type SecretStorageLike,
  type StoredToken,
  TOKEN_SECRET_KEY,
} from "../../../src/credential/types.js";
import type { CredentialPolicy } from "../../../src/manifest/types.js";

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

  describe("corrupt secrets", () => {
    it("treats unparseable JSON as absent and clears it", async () => {
      // Not JSON, and the whitespace inside rules it out as a token too.
      secrets.values.set(TOKEN_SECRET_KEY, "{not json");
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
    });

    it("treats a JSON value that is not an object as absent and clears it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, "[1,2,3]");
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
    });

    it("treats an object with no token as absent and clears it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify({ setAt: NOW.toISOString() }));
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
    });

    it("treats an empty-string token as absent and clears it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify({ token: "", setAt: "x" }));
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
    });

    it("treats an empty JSON string as absent and clears it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, JSON.stringify("  "));
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
    });

    it("treats an empty raw secret as absent and clears it", async () => {
      secrets.values.set(TOKEN_SECRET_KEY, "   ");
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
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

    it("refuses a bare string that could not be a key, and clears it", async () => {
      // An access key id in the secret is corruption, not a legacy token.
      secrets.values.set(TOKEN_SECRET_KEY, "AKIAIOSFODNN7EXAMPLE");
      await expect(store.get()).resolves.toBeUndefined();
      expect(secrets.values.has(TOKEN_SECRET_KEY)).toBe(false);
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
