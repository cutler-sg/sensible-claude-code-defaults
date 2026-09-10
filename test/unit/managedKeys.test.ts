import { describe, expect, it } from "vitest";
import {
  deletePath,
  getPath,
  isElementOwned,
  isJsonObject,
  setPath,
} from "../../src/config/managedKeys.js";
import { ConfigError, type Settings } from "../../src/config/types.js";

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
