import { describe, expect, it } from "vitest";
import { REDACTED } from "../../../src/config/managedKeys.js";
import type { Change } from "../../../src/config/types.js";
import { keyDisplayName } from "../../../src/health/labels.js";
import {
  accessibilityLabel,
  describeChange,
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

describe("formatValue", () => {
  it("renders containers by their contents, not as JSON", () => {
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue([])).toBe("(none)");
    expect(formatValue({ "plugin@repo": true })).toBe("plugin@repo");
    expect(formatValue({})).toBe("(none)");
    expect(formatValue(undefined)).toBe("(not set)");
    expect(formatValue(true)).toBe("true");
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
