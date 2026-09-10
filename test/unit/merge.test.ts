import { describe, expect, it } from "vitest";
import { deepEqual, merge } from "../../src/config/merge.js";
import {
  ConfigError,
  type Desired,
  type JsonValue,
  type Settings,
  type Snapshot,
} from "../../src/config/types.js";

const REGION = "env.AWS_REGION";
const OPUS = "env.ANTHROPIC_DEFAULT_OPUS_MODEL";
const TOKEN = "env.AWS_BEARER_TOKEN_BEDROCK";
const DENY = "permissions.deny";
const PLUGINS = "enabledPlugins";
const MARKETPLACES = "extraKnownMarketplaces";

const MARKETPLACE: JsonValue = {
  source: { source: "github", repo: "anthropics/claude-code-plugins" },
};

function snapshotOf(values: Snapshot["values"]): Snapshot {
  return { schemaVersion: 1, values };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Every case runs through here: it freezes the inputs, so any mutation of the
 * caller's document surfaces as a thrown TypeError rather than a silent bug.
 */
function run(current: Settings, snapshot: Snapshot, desired: Desired) {
  return merge(deepFreeze(current), deepFreeze(snapshot), deepFreeze(desired));
}

describe("deepEqual", () => {
  it.each<[string, JsonValue | undefined, JsonValue | undefined, boolean]>([
    ["identical primitives", "a", "a", true],
    ["different primitives", "a", "b", false],
    ["null and null", null, null, true],
    ["null and object", null, {}, false],
    ["object and null", {}, null, false],
    ["undefined and undefined", undefined, undefined, true],
    ["undefined and value", undefined, "a", false],
    ["value and undefined", "a", undefined, false],
    ["equal arrays", [1, 2], [1, 2], true],
    ["reordered arrays", [1, 2], [2, 1], false],
    ["arrays of different length", [1], [1, 2], false],
    ["array and object", [1], { 0: 1 }, false],
    ["object and array", { 0: 1 }, [1], false],
    ["array and primitive", [1], 1, false],
    ["equal objects", { a: 1, b: [2] }, { b: [2], a: 1 }, true],
    ["objects of different size", { a: 1 }, { a: 1, b: 2 }, false],
    ["objects with different keys", { a: 1 }, { b: 1 }, false],
    ["object and primitive", { a: 1 }, "a", false],
    ["primitive and object", "a", { a: 1 }, false],
    ["number and string", 1, "1", false],
  ])("%s", (_label, a, b, expected) => {
    expect(deepEqual(a, b)).toBe(expected);
  });
});

describe("row: key absent, snapshot absent", () => {
  it("adds a scalar when desired", () => {
    const result = run({}, snapshotOf({}), { [REGION]: "us-east-1" });
    expect(result.next).toEqual({ env: { AWS_REGION: "us-east-1" } });
    expect(result.changes).toEqual([
      { key: REGION, kind: "add", before: undefined, after: "us-east-1" },
    ]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [REGION]: "us-east-1" });
  });

  it("adds an array key when desired", () => {
    const result = run({}, snapshotOf({}), { [DENY]: ["Bash(rm -rf:*)"] });
    expect(result.next).toEqual({ permissions: { deny: ["Bash(rm -rf:*)"] } });
    expect(result.changes).toEqual([
      { key: DENY, kind: "add", before: undefined, after: ["Bash(rm -rf:*)"] },
    ]);
    expect(result.snapshotValues).toEqual({ [DENY]: ["Bash(rm -rf:*)"] });
  });

  it("adds a map key when desired", () => {
    const result = run({}, snapshotOf({}), { [PLUGINS]: { "a@market": true } });
    expect(result.next).toEqual({ enabledPlugins: { "a@market": true } });
    expect(result.changes).toEqual([
      { key: PLUGINS, kind: "add", before: undefined, after: { "a@market": true } },
    ]);
    expect(result.snapshotValues).toEqual({ [PLUGINS]: { "a@market": true } });
  });

  it("adds a map key whose values are nested objects", () => {
    const result = run({}, snapshotOf({}), { [MARKETPLACES]: { anthropics: MARKETPLACE } });
    expect(result.next).toEqual({ extraKnownMarketplaces: { anthropics: MARKETPLACE } });
    expect(result.snapshotValues).toEqual({ [MARKETPLACES]: { anthropics: MARKETPLACE } });
  });

  it("is a no-op for a removal", () => {
    const result = run({ model: "opus" }, snapshotOf({}), {
      [REGION]: undefined,
      [DENY]: undefined,
      [PLUGINS]: undefined,
    });
    expect(result.next).toEqual({ model: "opus" });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({});
  });
});

describe("row: key absent, snapshot present", () => {
  it("re-adds a scalar the user deleted rather than reporting drift", () => {
    const result = run({ env: {} }, snapshotOf({ [REGION]: "us-east-1" }), {
      [REGION]: "eu-west-1",
    });
    expect(result.next).toEqual({ env: { AWS_REGION: "eu-west-1" } });
    expect(result.changes).toEqual([
      { key: REGION, kind: "add", before: undefined, after: "eu-west-1" },
    ]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [REGION]: "eu-west-1" });
  });

  it("re-adds array elements the user deleted", () => {
    const result = run({ permissions: { deny: [] } }, snapshotOf({ [DENY]: ["a"] }), {
      [DENY]: ["a"],
    });
    expect(result.next).toEqual({ permissions: { deny: ["a"] } });
    expect(result.changes).toEqual([{ key: DENY, kind: "update", before: [], after: ["a"] }]);
    expect(result.drift).toEqual([]);
  });

  it("re-adds map entries the user deleted", () => {
    const result = run({ enabledPlugins: {} }, snapshotOf({ [PLUGINS]: { "a@m": true } }), {
      [PLUGINS]: { "a@m": true },
    });
    expect(result.next).toEqual({ enabledPlugins: { "a@m": true } });
    expect(result.drift).toEqual([]);
  });

  it("drops the snapshot entry on a removal without writing", () => {
    const result = run({ env: {} }, snapshotOf({ [REGION]: "us-east-1", [OPUS]: "m" }), {
      [REGION]: undefined,
    });
    expect(result.next).toEqual({ env: {} });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [OPUS]: "m" });
  });
});

describe("row: current equals snapshot", () => {
  it("leaves a scalar alone when it already equals the desired value", () => {
    const current: Settings = { env: { AWS_REGION: "us-east-1" } };
    const result = run(current, snapshotOf({ [REGION]: "us-east-1" }), { [REGION]: "us-east-1" });
    expect(result.next).toBe(current);
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [REGION]: "us-east-1" });
  });

  it("updates a scalar when the desired value moved on", () => {
    const result = run(
      { env: { AWS_REGION: "us-east-1" } },
      snapshotOf({ [REGION]: "us-east-1" }),
      {
        [REGION]: "eu-west-1",
      },
    );
    expect(result.next).toEqual({ env: { AWS_REGION: "eu-west-1" } });
    expect(result.changes).toEqual([
      { key: REGION, kind: "update", before: "us-east-1", after: "eu-west-1" },
    ]);
    expect(result.snapshotValues).toEqual({ [REGION]: "eu-west-1" });
  });

  it("removes a scalar we own", () => {
    const result = run(
      { env: { AWS_REGION: "us-east-1", MY_OWN: "x" } },
      snapshotOf({ [REGION]: "us-east-1" }),
      { [REGION]: undefined },
    );
    expect(result.next).toEqual({ env: { MY_OWN: "x" } });
    expect(result.changes).toEqual([
      { key: REGION, kind: "remove", before: "us-east-1", after: undefined },
    ]);
    expect(result.snapshotValues).toEqual({});
  });

  it("leaves an owned array element alone and appends new rules in order", () => {
    const result = run(
      { permissions: { deny: ["a", "user-rule"] } },
      snapshotOf({ [DENY]: ["a"] }),
      { [DENY]: ["a", "b"] },
    );
    expect(result.next).toEqual({ permissions: { deny: ["a", "user-rule", "b"] } });
    expect(result.changes).toEqual([
      { key: DENY, kind: "update", before: ["a", "user-rule"], after: ["a", "user-rule", "b"] },
    ]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [DENY]: ["a", "b"] });
  });

  it("removes only the owned array elements", () => {
    const result = run(
      { permissions: { deny: ["a", "user-rule", "b"] } },
      snapshotOf({ [DENY]: ["a", "b"] }),
      { [DENY]: ["b"] },
    );
    expect(result.next).toEqual({ permissions: { deny: ["user-rule", "b"] } });
    expect(result.snapshotValues).toEqual({ [DENY]: ["b"] });
  });

  it("leaves whatever remains when the last owned array element goes", () => {
    const result = run({ permissions: { deny: ["a"] } }, snapshotOf({ [DENY]: ["a"] }), {
      [DENY]: undefined,
    });
    expect(result.next).toEqual({ permissions: { deny: [] } });
    expect(result.changes).toEqual([{ key: DENY, kind: "update", before: ["a"], after: [] }]);
    expect(result.snapshotValues).toEqual({});
  });

  it("updates a map entry we own", () => {
    const result = run(
      { enabledPlugins: { "a@m": true, "user@m": true } },
      snapshotOf({ [PLUGINS]: { "a@m": true } }),
      { [PLUGINS]: { "a@m": ["sub"] } },
    );
    expect(result.next).toEqual({ enabledPlugins: { "a@m": ["sub"], "user@m": true } });
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [PLUGINS]: { "a@m": ["sub"] } });
  });

  it("removes a map entry we own and preserves the user's", () => {
    const result = run(
      { enabledPlugins: { "a@m": true, "user@m": true } },
      snapshotOf({ [PLUGINS]: { "a@m": true } }),
      { [PLUGINS]: undefined },
    );
    expect(result.next).toEqual({ enabledPlugins: { "user@m": true } });
    expect(result.changes).toEqual([
      {
        key: PLUGINS,
        kind: "update",
        before: { "a@m": true, "user@m": true },
        after: { "user@m": true },
      },
    ]);
    expect(result.snapshotValues).toEqual({});
  });

  it("updates an owned marketplace entry with a nested source", () => {
    const moved: JsonValue = { source: { source: "github", repo: "anthropics/plugins" } };
    const result = run(
      { extraKnownMarketplaces: { anthropics: MARKETPLACE } },
      snapshotOf({ [MARKETPLACES]: { anthropics: MARKETPLACE } }),
      { [MARKETPLACES]: { anthropics: moved } },
    );
    expect(result.next).toEqual({ extraKnownMarketplaces: { anthropics: moved } });
    expect(result.drift).toEqual([]);
  });
});

describe("row: current differs from snapshot", () => {
  it("preserves a scalar and reports drift", () => {
    const current: Settings = { env: { AWS_REGION: "ap-southeast-1" } };
    const result = run(current, snapshotOf({ [REGION]: "us-east-1" }), { [REGION]: "eu-west-1" });
    expect(result.next).toBe(current);
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      {
        key: REGION,
        current: "ap-southeast-1",
        lastApplied: "us-east-1",
        recommended: "eu-west-1",
      },
    ]);
    expect(result.snapshotValues).toEqual({ [REGION]: "us-east-1" });
  });

  it("preserves a scalar on removal and reports drift", () => {
    const result = run(
      { env: { AWS_REGION: "ap-southeast-1" } },
      snapshotOf({ [REGION]: "us-east-1" }),
      {
        [REGION]: undefined,
      },
    );
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      { key: REGION, current: "ap-southeast-1", lastApplied: "us-east-1", recommended: undefined },
    ]);
    expect(result.snapshotValues).toEqual({ [REGION]: "us-east-1" });
  });

  it("preserves a contested map entry and reports element-level drift", () => {
    const result = run(
      { enabledPlugins: { "a@m": false, "b@m": true } },
      snapshotOf({ [PLUGINS]: { "a@m": true, "b@m": true } }),
      { [PLUGINS]: { "a@m": true, "b@m": true } },
    );
    expect(result.next).toEqual({ enabledPlugins: { "a@m": false, "b@m": true } });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      {
        key: PLUGINS,
        current: { "a@m": false },
        lastApplied: { "a@m": true },
        recommended: { "a@m": true },
      },
    ]);
    expect(result.snapshotValues).toEqual({ [PLUGINS]: { "a@m": true, "b@m": true } });
  });

  it("preserves a contested map entry the manifest wants removed", () => {
    const result = run(
      { enabledPlugins: { "a@m": false } },
      snapshotOf({ [PLUGINS]: { "a@m": true } }),
      { [PLUGINS]: {} },
    );
    expect(result.next).toEqual({ enabledPlugins: { "a@m": false } });
    expect(result.drift).toEqual([
      { key: PLUGINS, current: { "a@m": false }, lastApplied: { "a@m": true }, recommended: {} },
    ]);
  });

  it("still writes the uncontested entries alongside a contested one", () => {
    const result = run(
      { enabledPlugins: { "a@m": false, "b@m": true } },
      snapshotOf({ [PLUGINS]: { "a@m": true, "b@m": true } }),
      { [PLUGINS]: { "a@m": true, "b@m": ["only-this"] } },
    );
    expect(result.next).toEqual({ enabledPlugins: { "a@m": false, "b@m": ["only-this"] } });
    expect(result.drift.map((d) => d.key)).toEqual([PLUGINS]);
    expect(result.snapshotValues).toEqual({
      [PLUGINS]: { "a@m": true, "b@m": ["only-this"] },
    });
  });

  it("has no per-element drift for arrays, whose identity is their value", () => {
    // A "changed" deny rule is indistinguishable from a removal plus an
    // addition, so it resolves as one of those, never as a contest.
    const result = run({ permissions: { deny: ["a-edited"] } }, snapshotOf({ [DENY]: ["a"] }), {
      [DENY]: ["a"],
    });
    expect(result.next).toEqual({ permissions: { deny: ["a-edited", "a"] } });
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [DENY]: ["a"] });
  });
});

describe("row: snapshot absent, key present", () => {
  it("preserves an unowned scalar and drifts only when it differs from desired", () => {
    const current: Settings = { env: { AWS_REGION: "ap-southeast-1" } };
    const result = run(current, snapshotOf({}), { [REGION]: "us-east-1" });
    expect(result.next).toBe(current);
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      {
        key: REGION,
        current: "ap-southeast-1",
        lastApplied: undefined,
        recommended: "us-east-1",
      },
    ]);
    expect(result.snapshotValues).toEqual({});
  });

  it("does not drift when an unowned scalar already matches, and does not adopt it", () => {
    const result = run({ env: { AWS_REGION: "us-east-1" } }, snapshotOf({}), {
      [REGION]: "us-east-1",
    });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({});
  });

  it("preserves an unowned scalar on removal without drift", () => {
    const result = run({ env: { AWS_REGION: "ap-southeast-1" } }, snapshotOf({}), {
      [REGION]: undefined,
    });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({});
  });

  it("keeps user-added array elements and never drifts on them", () => {
    const result = run({ permissions: { deny: ["user-rule"] } }, snapshotOf({}), {
      [DENY]: ["a"],
    });
    expect(result.next).toEqual({ permissions: { deny: ["user-rule", "a"] } });
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({ [DENY]: ["a"] });
  });

  it("keeps user-added array elements on removal", () => {
    const result = run({ permissions: { deny: ["user-rule"] } }, snapshotOf({}), {
      [DENY]: undefined,
    });
    expect(result.changes).toEqual([]);
    expect(result.snapshotValues).toEqual({});
  });

  it("drifts on an unowned map entry the manifest wants to change", () => {
    const result = run({ enabledPlugins: { "a@m": false } }, snapshotOf({}), {
      [PLUGINS]: { "a@m": true },
    });
    expect(result.next).toEqual({ enabledPlugins: { "a@m": false } });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      {
        key: PLUGINS,
        current: { "a@m": false },
        lastApplied: {},
        recommended: { "a@m": true },
      },
    ]);
    expect(result.snapshotValues).toEqual({});
  });

  it("leaves an unowned map entry alone when it already matches", () => {
    const result = run({ enabledPlugins: { "a@m": true } }, snapshotOf({}), {
      [PLUGINS]: { "a@m": true },
    });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.snapshotValues).toEqual({});
  });

  it("never removes an unowned map entry", () => {
    const result = run({ enabledPlugins: { "user@m": true } }, snapshotOf({}), {
      [PLUGINS]: undefined,
    });
    expect(result.next).toEqual({ enabledPlugins: { "user@m": true } });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
  });
});

describe("wrong-typed element-owned values", () => {
  it("preserves a string permissions.deny, drifts, and writes nothing", () => {
    const current: Settings = { permissions: { deny: "Bash(rm:*)" } };
    const result = run(current, snapshotOf({ [DENY]: ["a"] }), { [DENY]: ["a", "b"] });
    expect(result.next).toBe(current);
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      {
        key: DENY,
        current: "Bash(rm:*)",
        lastApplied: ["a"],
        recommended: ["a", "b"],
      },
    ]);
    expect(result.snapshotValues).toEqual({ [DENY]: ["a"] });
  });

  it("preserves an array enabledPlugins and drifts", () => {
    const result = run({ enabledPlugins: ["a@m"] }, snapshotOf({}), {
      [PLUGINS]: { "a@m": true },
    });
    expect(result.next).toEqual({ enabledPlugins: ["a@m"] });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      { key: PLUGINS, current: ["a@m"], lastApplied: undefined, recommended: { "a@m": true } },
    ]);
  });

  it("tolerates a wrong-shaped snapshot by treating it as owning nothing", () => {
    const result = run({ permissions: { deny: ["user-rule"] } }, snapshotOf({ [DENY]: "a" }), {
      [DENY]: ["b"],
    });
    expect(result.next).toEqual({ permissions: { deny: ["user-rule", "b"] } });
    expect(result.snapshotValues).toEqual({ [DENY]: ["b"] });
  });

  it("rejects a desired value of the wrong shape", () => {
    expect(() => run({}, snapshotOf({}), { [DENY]: "Bash(rm:*)" })).toThrow(ConfigError);
    expect(() => run({}, snapshotOf({}), { [PLUGINS]: ["a@m"] })).toThrow(/must be an object/);
  });
});

describe("malformed containers", () => {
  it("throws MALFORMED_SETTINGS when env is not an object", () => {
    const call = () => run({ env: "production" }, snapshotOf({}), { [REGION]: "us-east-1" });
    expect(call).toThrow(ConfigError);
    expect(call).toThrow(/"env" must be a JSON object/);
    try {
      call();
    } catch (error) {
      expect((error as ConfigError).code).toBe("MALFORMED_SETTINGS");
    }
  });

  it("throws when permissions is not an object", () => {
    expect(() => run({ permissions: [] }, snapshotOf({}), { [DENY]: ["a"] })).toThrow(ConfigError);
  });

  it("creates env when it is absent", () => {
    const result = run({ model: "opus" }, snapshotOf({}), { [REGION]: "us-east-1" });
    expect(result.next).toEqual({ model: "opus", env: { AWS_REGION: "us-east-1" } });
  });
});

describe("unmanaged content", () => {
  const handWritten: Settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] },
    env: { MY_OWN: "keep me", AWS_REGION: "us-east-1" },
    statusLine: { type: "command", command: "hwi-status" },
  };

  it("preserves unmanaged keys and their order", () => {
    const result = run(handWritten, snapshotOf({ [REGION]: "us-east-1" }), {
      [REGION]: "eu-west-1",
      [OPUS]: "opus-id",
      [DENY]: ["a"],
    });
    expect(Object.keys(result.next)).toEqual([
      "$schema",
      "model",
      "hooks",
      "env",
      "statusLine",
      "permissions",
    ]);
    expect(Object.keys(result.next.env as object)).toEqual([
      "MY_OWN",
      "AWS_REGION",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
    expect(result.next.hooks).toEqual(handWritten.hooks);
    expect(result.next.statusLine).toEqual(handWritten.statusLine);
  });

  it("keeps $schema first", () => {
    const result = run(handWritten, snapshotOf({}), { [PLUGINS]: { "a@m": true } });
    expect(Object.keys(result.next)[0]).toBe("$schema");
  });

  it("ignores managed keys absent from desired", () => {
    const result = run(handWritten, snapshotOf({}), {});
    expect(result.next).toBe(handWritten);
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
  });
});

describe("snapshot bookkeeping", () => {
  it("carries forward snapshot keys this apply does not address", () => {
    const result = run(
      { env: { AWS_REGION: "us-east-1" } },
      snapshotOf({ [REGION]: "us-east-1", [OPUS]: "opus-id", [DENY]: ["a"] }),
      { [REGION]: "eu-west-1" },
    );
    expect(result.snapshotValues).toEqual({
      [REGION]: "eu-west-1",
      [OPUS]: "opus-id",
      [DENY]: ["a"],
    });
  });

  it("does not mutate the snapshot it was given", () => {
    const snapshot = snapshotOf({ [REGION]: "us-east-1" });
    const result = run({ env: { AWS_REGION: "us-east-1" } }, snapshot, { [REGION]: undefined });
    expect(snapshot.values).toEqual({ [REGION]: "us-east-1" });
    expect(result.snapshotValues).toEqual({});
  });
});

describe("scenarios", () => {
  it("first run over a hand-written config preserves everything and writes nothing", () => {
    const current: Settings = {
      env: {
        CLAUDE_CODE_USE_BEDROCK: "0",
        AWS_REGION: "ap-southeast-1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "their-opus",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "their-sonnet",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "their-haiku",
        AWS_BEARER_TOKEN_BEDROCK: "their-token",
      },
      permissions: { deny: ["their-rule"] },
      extraKnownMarketplaces: { theirs: MARKETPLACE },
      enabledPlugins: { "theirs@theirs": true },
    };
    const desired: Desired = {
      "env.CLAUDE_CODE_USE_BEDROCK": "1",
      [REGION]: "us-east-1",
      [OPUS]: "our-opus",
      "env.ANTHROPIC_DEFAULT_SONNET_MODEL": "our-sonnet",
      "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "our-haiku",
      [TOKEN]: "our-token",
      [DENY]: ["their-rule"],
      [MARKETPLACES]: { theirs: MARKETPLACE },
      [PLUGINS]: { "theirs@theirs": true },
    };

    const result = run(current, snapshotOf({}), desired);
    expect(result.next).toBe(current);
    expect(result.changes).toEqual([]);
    // The six scalars differ from the recommendation; the three element-owned
    // keys already match theirs element-for-element, so they are not drift.
    expect(result.drift.map((d) => d.key)).toEqual([
      "env.CLAUDE_CODE_USE_BEDROCK",
      REGION,
      OPUS,
      "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
      "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
      TOKEN,
    ]);
    expect(result.drift.every((d) => d.lastApplied === undefined)).toBe(true);
    expect(result.snapshotValues).toEqual({});
  });

  it("rotates a token we own", () => {
    const result = run(
      { env: { AWS_BEARER_TOKEN_BEDROCK: "old" } },
      snapshotOf({ [TOKEN]: "old" }),
      { [TOKEN]: "new" },
    );
    expect(result.next).toEqual({ env: { AWS_BEARER_TOKEN_BEDROCK: "new" } });
    expect(result.changes).toEqual([{ key: TOKEN, kind: "update", before: "old", after: "new" }]);
    expect(result.snapshotValues).toEqual({ [TOKEN]: "new" });
  });

  it("clears a token we own", () => {
    const result = run(
      { env: { AWS_BEARER_TOKEN_BEDROCK: "old", AWS_REGION: "us-east-1" } },
      snapshotOf({ [TOKEN]: "old" }),
      { [TOKEN]: undefined },
    );
    expect(result.next).toEqual({ env: { AWS_REGION: "us-east-1" } });
    expect(result.changes).toEqual([
      { key: TOKEN, kind: "remove", before: "old", after: undefined },
    ]);
    expect(result.snapshotValues).toEqual({});
  });

  it("refuses to clear a token the user replaced", () => {
    const result = run(
      { env: { AWS_BEARER_TOKEN_BEDROCK: "theirs" } },
      snapshotOf({ [TOKEN]: "ours" }),
      { [TOKEN]: undefined },
    );
    expect(result.next).toEqual({ env: { AWS_BEARER_TOKEN_BEDROCK: "theirs" } });
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([
      { key: TOKEN, current: "theirs", lastApplied: "ours", recommended: undefined },
    ]);
  });

  it("treats a /setup-bedrock rewrite as drift on that key alone", () => {
    // Claude Code's wizard rewrote the Opus pin after our apply; the region is
    // still ours and the manifest has moved on.
    const result = run(
      {
        env: {
          AWS_REGION: "us-east-1",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-code-wrote-this",
        },
      },
      snapshotOf({ [REGION]: "us-east-1", [OPUS]: "our-opus" }),
      { [REGION]: "eu-west-1", [OPUS]: "our-newer-opus" },
    );
    expect(result.next).toEqual({
      env: {
        AWS_REGION: "eu-west-1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-code-wrote-this",
      },
    });
    expect(result.changes).toEqual([
      { key: REGION, kind: "update", before: "us-east-1", after: "eu-west-1" },
    ]);
    expect(result.drift).toEqual([
      {
        key: OPUS,
        current: "claude-code-wrote-this",
        lastApplied: "our-opus",
        recommended: "our-newer-opus",
      },
    ]);
    expect(result.snapshotValues).toEqual({ [REGION]: "eu-west-1", [OPUS]: "our-opus" });
  });

  it("rejects keys outside MANAGED_KEYS at compile time", () => {
    // @ts-expect-error apiKeyHelper is not a managed key.
    const desired: Desired = { apiKeyHelper: "echo hi" };
    expect(desired).toBeDefined();
  });
});
