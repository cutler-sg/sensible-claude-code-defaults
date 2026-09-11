import { describe, expect, it } from "vitest";
import {
  deletePath,
  getPath,
  isElementOwned,
  isJsonObject,
  REDACTED,
  redactChanges,
  redactDrift,
  SECRET_KEYS,
  setPath,
} from "../../src/config/managedKeys.js";
import {
  type Change,
  ConfigError,
  type Drift,
  type ManagedKey,
  type Settings,
} from "../../src/config/types.js";

const baseEnv = { AWS_REGION: "us-east-1", MY_OWN: "keep me" };

const base: Settings = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  model: "opus",
  env: baseEnv,
};

describe("isJsonObject", () => {
  it("accepts plain objects only", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("env")).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe("isElementOwned", () => {
  it("is true for the array and map keys", () => {
    expect(isElementOwned("permissions.deny")).toBe(true);
    expect(isElementOwned("enabledPlugins")).toBe(true);
    expect(isElementOwned("extraKnownMarketplaces")).toBe(true);
  });

  it("is false for scalar env keys", () => {
    expect(isElementOwned("env.AWS_REGION")).toBe(false);
    expect(isElementOwned("env.AWS_BEARER_TOKEN_BEDROCK")).toBe(false);
  });
});

describe("getPath", () => {
  it("reads a nested key", () => {
    expect(getPath(base, "env.AWS_REGION")).toBe("us-east-1");
  });

  it("reads a root key", () => {
    expect(getPath({ enabledPlugins: { "a@b": true } }, "enabledPlugins")).toEqual({ "a@b": true });
  });

  it("returns undefined when the parent is absent", () => {
    expect(getPath({}, "env.AWS_REGION")).toBeUndefined();
  });

  it("returns undefined when the leaf is absent", () => {
    expect(getPath(base, "env.ANTHROPIC_DEFAULT_OPUS_MODEL")).toBeUndefined();
  });

  it.each([
    ["a string", "prod"],
    ["an array", []],
    ["null", null],
    ["a number", 1],
  ])("throws MALFORMED_SETTINGS when the parent is %s", (_label, env) => {
    const call = () => getPath({ env } as Settings, "env.AWS_REGION");
    expect(call).toThrow(ConfigError);
    expect(call).toThrow(/must be a JSON object/);
  });

  it("names the offending type in the error", () => {
    expect(() => getPath({ env: null }, "env.AWS_REGION")).toThrow(/found null/);
    expect(() => getPath({ env: [] }, "env.AWS_REGION")).toThrow(/found an array/);
    expect(() => getPath({ env: "x" }, "env.AWS_REGION")).toThrow(/found a string/);
  });
});

describe("setPath", () => {
  it("does not mutate the input", () => {
    const frozen: Settings = Object.freeze({ ...base, env: Object.freeze({ ...baseEnv }) });
    const next = setPath(frozen, "env.AWS_REGION", "eu-west-1");
    expect(getPath(frozen, "env.AWS_REGION")).toBe("us-east-1");
    expect(getPath(next, "env.AWS_REGION")).toBe("eu-west-1");
  });

  it("creates env when absent", () => {
    const next = setPath({ model: "opus" }, "env.AWS_REGION", "us-east-1");
    expect(next).toEqual({ model: "opus", env: { AWS_REGION: "us-east-1" } });
  });

  it("leaves sibling env entries untouched", () => {
    const next = setPath(base, "env.AWS_REGION", "eu-west-1");
    expect((next.env as Record<string, unknown>).MY_OWN).toBe("keep me");
  });

  it("preserves key order and appends new keys at the end of their parent", () => {
    const next = setPath(base, "env.CLAUDE_CODE_USE_BEDROCK", "1");
    expect(Object.keys(next)).toEqual(["$schema", "model", "env"]);
    expect(Object.keys(next.env as object)).toEqual([
      "AWS_REGION",
      "MY_OWN",
      "CLAUDE_CODE_USE_BEDROCK",
    ]);
  });

  it("preserves position when overwriting an existing key", () => {
    const next = setPath(base, "env.AWS_REGION", "eu-west-1");
    expect(Object.keys(next.env as object)).toEqual(["AWS_REGION", "MY_OWN"]);
  });

  it("appends a new root key at the end", () => {
    const next = setPath(base, "enabledPlugins", { "a@b": true });
    expect(Object.keys(next)).toEqual(["$schema", "model", "env", "enabledPlugins"]);
  });

  it("throws when the parent is not an object", () => {
    expect(() => setPath({ env: "prod" }, "env.AWS_REGION", "x")).toThrow(ConfigError);
  });
});

describe("deletePath", () => {
  it("removes a nested key and leaves an empty env behind", () => {
    const next = deletePath({ env: { AWS_REGION: "us-east-1" } }, "env.AWS_REGION");
    expect(next).toEqual({ env: {} });
  });

  it("keeps sibling env entries", () => {
    const next = deletePath(base, "env.AWS_REGION");
    expect(next.env).toEqual({ MY_OWN: "keep me" });
  });

  it("removes a root key", () => {
    expect(deletePath({ model: "opus", enabledPlugins: {} }, "enabledPlugins")).toEqual({
      model: "opus",
    });
  });

  it("is a no-op when the root key is absent", () => {
    const settings: Settings = { model: "opus" };
    expect(deletePath(settings, "enabledPlugins")).toBe(settings);
  });

  it("is a no-op when the parent is absent", () => {
    const settings: Settings = { model: "opus" };
    expect(deletePath(settings, "env.AWS_REGION")).toBe(settings);
  });

  it("is a no-op when the leaf is absent", () => {
    const settings: Settings = { env: { MY_OWN: "x" } };
    expect(deletePath(settings, "env.AWS_REGION")).toBe(settings);
  });

  it("does not mutate the input", () => {
    const frozen = Object.freeze({ env: Object.freeze({ AWS_REGION: "us-east-1" }) }) as Settings;
    deletePath(frozen, "env.AWS_REGION");
    expect(frozen.env).toEqual({ AWS_REGION: "us-east-1" });
  });

  it("throws when the parent is not an object", () => {
    expect(() => deletePath({ env: 3 }, "env.AWS_REGION")).toThrow(ConfigError);
  });
});

describe("keys that collide with Object.prototype", () => {
  /**
   * No managed key's segments collide with `Object.prototype` today, so these
   * are guards against a future key rather than a live bug: the accessors must
   * read own properties only, and must never let a segment named `__proto__`
   * reach an assignment that would reassign a prototype.
   */
  const PROTO = "env.__proto__" as ManagedKey;

  it("rejects a prototype-named key at compile time", () => {
    // @ts-expect-error `env.__proto__` is not in MANAGED_KEYS.
    const key: ManagedKey = "env.__proto__";
    expect(key).toBe("env.__proto__");
  });

  it("does not read a leaf through the prototype chain", () => {
    expect(getPath({ env: {} }, PROTO)).toBeUndefined();
    expect(getPath({ env: {} }, "toString" as ManagedKey)).toBeUndefined();
  });

  it("does not read a parent through the prototype chain", () => {
    // `constructor` resolves to a function on any ordinary object; treating it
    // as a container would throw MALFORMED_SETTINGS on a perfectly good file.
    expect(getPath({}, "constructor.AWS_REGION" as ManagedKey)).toBeUndefined();
  });

  it("sets a prototype-named leaf as an own property", () => {
    const next = setPath({ env: { A: "1" } }, PROTO, "value");
    const env = next.env as object;

    expect(Object.hasOwn(env, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    // Written as a literal, `{ __proto__: ... }` would set a prototype rather
    // than a key, so compare the serialised bytes the writer would emit.
    expect(JSON.stringify(next)).toBe('{"env":{"A":"1","__proto__":"value"}}');
  });

  it("sets a prototype-named root key as an own property", () => {
    const next = setPath({ model: "opus" }, "__proto__" as ManagedKey, "value");

    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("deletes a prototype-named leaf without disturbing siblings", () => {
    const settings = JSON.parse('{"env":{"__proto__":"x","A":"1"}}') as Settings;
    const next = deletePath(settings, PROTO);

    expect(JSON.stringify(next)).toBe('{"env":{"A":"1"}}');
  });

  it("is a no-op when a prototype-named leaf is absent", () => {
    const settings: Settings = { env: { A: "1" } };
    expect(deletePath(settings, PROTO)).toBe(settings);
    expect(deletePath(settings, "toString" as ManagedKey)).toBe(settings);
  });
});

describe("SECRET_KEYS", () => {
  it("covers the Bedrock bearer token", () => {
    expect([...SECRET_KEYS]).toEqual(["env.AWS_BEARER_TOKEN_BEDROCK"]);
  });
});

describe("redactChanges", () => {
  const tokenChange: Change = {
    key: "env.AWS_BEARER_TOKEN_BEDROCK",
    kind: "update",
    before: "ABSK-old-secret",
    after: "ABSK-new-secret",
  };

  it("replaces both sides of a secret change", () => {
    expect(redactChanges([tokenChange])).toEqual([
      {
        key: "env.AWS_BEARER_TOKEN_BEDROCK",
        kind: "update",
        before: REDACTED,
        after: REDACTED,
      },
    ]);
  });

  it("keeps `undefined` distinguishable from a redacted value", () => {
    // An add has no `before` and a remove has no `after`; showing «redacted»
    // there would claim a secret existed when none did.
    expect(redactChanges([{ ...tokenChange, kind: "add", before: undefined }])[0]).toMatchObject({
      before: undefined,
      after: REDACTED,
    });
    expect(redactChanges([{ ...tokenChange, kind: "remove", after: undefined }])[0]).toMatchObject({
      before: REDACTED,
      after: undefined,
    });
  });

  it("leaves non-secret changes untouched", () => {
    const change: Change = {
      key: "env.AWS_REGION",
      kind: "update",
      before: "us-east-1",
      after: "eu-west-1",
    };
    expect(redactChanges([change])).toEqual([change]);
  });

  it("does not mutate the input", () => {
    const changes = [tokenChange];
    redactChanges(changes);
    expect(changes[0]?.after).toBe("ABSK-new-secret");
  });

  it("redacts only the secret entries of a mixed list", () => {
    const region: Change = {
      key: "env.AWS_REGION",
      kind: "add",
      before: undefined,
      after: "us-east-1",
    };
    expect(redactChanges([region, tokenChange]).map((change) => change.after)).toEqual([
      "us-east-1",
      REDACTED,
    ]);
  });
});

describe("redactDrift", () => {
  const tokenDrift: Drift = {
    key: "env.AWS_BEARER_TOKEN_BEDROCK",
    current: "ABSK-theirs",
    lastApplied: "ABSK-ours",
    recommended: "ABSK-manifest",
  };

  it("replaces every value of a secret drift entry", () => {
    expect(redactDrift([tokenDrift])).toEqual([
      {
        key: "env.AWS_BEARER_TOKEN_BEDROCK",
        current: REDACTED,
        lastApplied: REDACTED,
        recommended: REDACTED,
      },
    ]);
  });

  it("keeps `undefined` fields as they are", () => {
    expect(redactDrift([{ ...tokenDrift, lastApplied: undefined }])[0]).toMatchObject({
      lastApplied: undefined,
      current: REDACTED,
    });
  });

  it("leaves non-secret drift untouched", () => {
    const drift: Drift = {
      key: "permissions.deny",
      current: ["a"],
      lastApplied: undefined,
      recommended: ["a", "b"],
    };
    expect(redactDrift([drift])).toEqual([drift]);
  });

  it("does not mutate the input", () => {
    const entries = [tokenDrift];
    redactDrift(entries);
    expect(entries[0]?.current).toBe("ABSK-theirs");
  });
});
