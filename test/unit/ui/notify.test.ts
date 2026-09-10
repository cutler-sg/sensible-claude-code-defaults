import { describe, expect, it } from "vitest";
import { type CheckResult, countLevels, type HealthReport } from "../../../src/health/types.js";
import { APPLY_ACTION, DETAILS_ACTION, decideNotification } from "../../../src/ui/notify.js";

function report(results: CheckResult[]): HealthReport {
  return { at: "2026-09-10T00:00:00Z", results, counts: countLevels(results) };
}

const failing: CheckResult = {
  id: "config.bedrock",
  group: "Configuration",
  level: "error",
  label: "Claude Code isn't pointed at AWS Bedrock",
  fix: { kind: "none" },
};

const passing: CheckResult = { ...failing, level: "pass", label: "Pointed at AWS Bedrock" };

describe("decideNotification (FR-5.5)", () => {
  it("offers to set things up on a first run", () => {
    expect(decideNotification("first-run", report([failing]))).toEqual({
      message: "Claude Code isn't set up for AWS Bedrock yet.",
      actions: [APPLY_ACTION],
    });
  });

  it("points at the panel when a healthy config starts failing", () => {
    expect(decideNotification("healthy-to-fail", report([failing]))).toEqual({
      message: "Claude Code configuration needs attention.",
      actions: [DETAILS_ACTION],
    });
  });

  it("stays silent when nothing transitioned", () => {
    expect(decideNotification("none", report([failing]))).toBeUndefined();
  });

  it("stays silent rather than point at an all-green panel", () => {
    expect(decideNotification("healthy-to-fail", report([passing]))).toBeUndefined();
  });
});
