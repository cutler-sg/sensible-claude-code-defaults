import { describe, expect, it } from "vitest";
import { compareVersions } from "../../../src/manifest/version.js";

describe("compareVersions", () => {
  it.each([
    ["2.1.267", "2.1.267", 0],
    ["2.1.267", "2.1.266", 1],
    ["2.1.266", "2.1.267", -1],
    ["2.2.0", "2.1.999", 1],
    ["10.0.0", "9.999.999", 1],
    ["0.1.0", "0.1.0", 0],
  ] as const)("%s vs %s → %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("2.1.1", "2.1")).toBe(1);
    expect(compareVersions("2", "2.0.0")).toBe(0);
  });

  it("ignores a pre-release or build suffix", () => {
    expect(compareVersions("1.98.0-insider", "1.98.0")).toBe(0);
    expect(compareVersions("1.98.0+build.7", "1.98.0")).toBe(0);
    expect(compareVersions("1.98.0-insider", "1.98.1")).toBe(-1);
  });

  it("tolerates a leading v and surrounding whitespace", () => {
    expect(compareVersions(" v2.1.0 ", "2.1.0")).toBe(0);
  });

  it("treats unparseable segments as zero rather than throwing", () => {
    expect(compareVersions("2.x.1", "2.0.1")).toBe(0);
    expect(compareVersions("", "0.0.0")).toBe(0);
    expect(compareVersions("nonsense", "0")).toBe(0);
  });
});
