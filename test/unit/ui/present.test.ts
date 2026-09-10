import { describe, expect, it } from "vitest";
import { REDACTED } from "../../../src/config/managedKeys.js";
import type { Change } from "../../../src/config/types.js";
import { keyDisplayName } from "../../../src/health/labels.js";
import {
  accessibilityLabel,
  describeChange,
  describeDroppedProtection,
  droppedProtections,
  formatValue,
  iconFor,
  pluralize,
  relativeAge,
} from "../../../src/ui/present.js";

describe("iconFor", () => {
  it("maps every level to a codicon, tinting all but info", () => {
    expect(iconFor("pass")).toEqual({ id: "check", color: "testing.iconPassed" });
    expect(iconFor("warning")).toEqual({ id: "warning", color: "list.warningForeground" });
    expect(iconFor("error")).toEqual({ id: "error", color: "list.errorForeground" });
    expect(iconFor("info")).toEqual({ id: "info" });
    expect(iconFor("skipped")).toEqual({ id: "circle-outline", color: "disabledForeground" });
  });
});

describe("accessibilityLabel", () => {
  it("restores the group context a screen reader loses on a leaf", () => {
    expect(accessibilityLabel("Configuration", "Region is set", "pass")).toBe(
      "Configuration: Region is set, pass",
    );
  });
});

describe("keyDisplayName (from health/labels.ts)", () => {
  it("names keys in words, never as env vars (FR-5.3)", () => {
    expect(keyDisplayName("env.AWS_REGION")).not.toMatch(/AWS_REGION|env\./);
    expect(keyDisplayName("env.AWS_BEARER_TOKEN_BEDROCK")).not.toMatch(/AWS_BEARER/);
  });
});

describe("describeChange", () => {
  const change = (over: Partial<Change>): Change => ({
    key: "env.AWS_REGION",
    kind: "update",
    before: "us-east-1",
    after: "eu-central-1",
    ...over,
  });

  it("renders before → after in plain words", () => {
    expect(describeChange(change({}))).toBe(
      `${keyDisplayName("env.AWS_REGION")} — us-east-1 → eu-central-1`,
    );
  });

  it("shows an add as (not set) → value", () => {
    expect(describeChange(change({ kind: "add", before: undefined }))).toBe(
      `${keyDisplayName("env.AWS_REGION")} — (not set) → eu-central-1`,
    );
  });

  it("shows a remove as → (removed)", () => {
    expect(describeChange(change({ kind: "remove", after: undefined }))).toBe(
      `${keyDisplayName("env.AWS_REGION")} — us-east-1 → (removed)`,
    );
  });

  it("never renders a secret's value, even one that skipped redactChanges", () => {
    const rendered = describeChange(
      change({
        key: "env.AWS_BEARER_TOKEN_BEDROCK",
        before: "sk-old-token",
        after: "sk-new-token",
      }),
    );
    expect(rendered).not.toContain("sk-old-token");
    expect(rendered).not.toContain("sk-new-token");
    expect(rendered).toBe(
      `${keyDisplayName("env.AWS_BEARER_TOKEN_BEDROCK")} — ${REDACTED} → ${REDACTED}`,
    );
  });

  it("does not claim a secret that never existed", () => {
    expect(
      describeChange(
        change({ key: "env.AWS_BEARER_TOKEN_BEDROCK", kind: "add", before: undefined }),
      ),
    ).toBe(`${keyDisplayName("env.AWS_BEARER_TOKEN_BEDROCK")} — (not set) → ${REDACTED}`);
  });
});

/**
 * F2. The deny list is element-owned, so elements we wrote are ours to remove:
 * a manifest revision that simply stops listing `Read(./.env)` removes it from
 * every install at once. `drift` stays empty, nothing reports it, and
 * `config.stale` says only "there are newer recommended settings to apply" —
 * which the user presses.
 *
 * The removal *is* in the preview, rendered by `describeChange` as a before and
 * an after set joined by commas. Reading it means diffing two comma-separated
 * lists by eye, which is precisely the task this extension exists because its
 * audience cannot do. So a dropped protection has to be its own sentence.
 */
describe("droppedProtections", () => {
  const denyChange = (before: string[] | undefined, after: string[]): Change => ({
    key: "permissions.deny",
    kind: before === undefined ? "add" : "update",
    before,
    after,
  });

  it("names each rule that stops being blocked", () => {
    expect(
      droppedProtections([denyChange(["Bash(rm -rf:*)", "Read(./.env)"], ["Bash(rm -rf:*)"])]),
    ).toEqual(["Read(./.env)"]);
  });

  it("names every one of several, not just the first", () => {
    expect(
      droppedProtections([
        denyChange(["Bash(rm -rf:*)", "Read(./.env)", "Read(./.aws/**)"], ["Bash(rm -rf:*)"]),
      ]),
    ).toEqual(["Read(./.env)", "Read(./.aws/**)"]);
  });

  it("says nothing when the list only grows", () => {
    expect(
      droppedProtections([denyChange(["Read(./.env)"], ["Read(./.env)", "Read(./.ssh/**)"])]),
    ).toEqual([]);
  });

  it("says nothing about a list being created", () => {
    expect(droppedProtections([denyChange(undefined, ["Read(./.env)"])])).toEqual([]);
  });

  it("reads a whole-key removal as dropping everything in it", () => {
    expect(
      droppedProtections([
        { key: "permissions.deny", kind: "remove", before: ["Read(./.env)"], after: undefined },
      ]),
    ).toEqual(["Read(./.env)"]);
  });

  it("ignores every other managed key", () => {
    expect(
      droppedProtections([
        { key: "env.AWS_REGION", kind: "update", before: "us-east-1", after: "eu-central-1" },
        { key: "enabledPlugins", kind: "update", before: { a: true }, after: {} },
      ]),
    ).toEqual([]);
  });

  it("survives a malformed before or after rather than hiding the rest", () => {
    expect(
      droppedProtections([
        { key: "permissions.deny", kind: "update", before: "not a list", after: [] },
      ]),
    ).toEqual([]);
  });

  /** Rules are strings by schema, but the preview must never render an object. */
  it("renders a non-string rule as text rather than [object Object]", () => {
    const dropped = droppedProtections([
      denyChange([{ nested: "rule" } as never, "Read(./.env)"], []),
    ]);
    expect(dropped).toHaveLength(2);
    for (const rule of dropped) expect(rule).not.toContain("[object Object]");
  });
});

describe("describeDroppedProtection", () => {
  it("states the loss as a sentence, not as a diff", () => {
    expect(describeDroppedProtection("Read(./.env)")).toBe("Stops blocking: Read(./.env)");
  });
});

describe("formatValue", () => {
  it("renders containers by their contents, not as JSON", () => {
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue([])).toBe("(none)");
    expect(formatValue({ "plugin@repo": true })).toBe("plugin@repo");
    expect(formatValue({})).toBe("(none)");
    expect(formatValue(undefined)).toBe("(not set)");
    expect(formatValue(true)).toBe("true");
    // An empty string is `""` rather than nothing at all, so a value that is
    // present but blank cannot be misread as unset.
    expect(formatValue("")).toBe('""');
    expect(formatValue(null)).toBe("null");
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("reads as a human describing when, not a timestamp", () => {
    expect(relativeAge(ago(5_000), now)).toBe("just now");
    expect(relativeAge(ago(60_000), now)).toBe("1 minute ago");
    expect(relativeAge(ago(10 * 60_000), now)).toBe("10 minutes ago");
    expect(relativeAge(ago(3 * 3_600_000), now)).toBe("3 hours ago");
    expect(relativeAge(ago(2 * 86_400_000), now)).toBe("2 days ago");
  });
});

describe("pluralize", () => {
  it("agrees with its count", () => {
    expect(pluralize(1, "change")).toBe("1 change");
    expect(pluralize(3, "change")).toBe("3 changes");
  });
});
