import { describe, expect, it } from "vitest";
import { ALL_CHECKS } from "../../../src/health/catalogue.js";
import type { CheckId } from "../../../src/health/types.js";
import { CHECK_GROUPS } from "../../../src/health/types.js";
import { makeCtx } from "./fixture.js";

const EVERY_ID: readonly CheckId[] = [
  "install.extension",
  "install.version",
  "install.cli",
  "config.exists",
  "config.parses",
  "config.perms",
  "config.bedrock",
  "config.region",
  "config.models",
  "config.drift",
  "config.stale",
  "cred.present",
  "cred.mirrored",
  "cred.valid",
  "cred.age",
  "cred.leak",
  "plugins.marketplace",
  "plugins.enabled",
];

describe("catalogue", () => {
  it("has no duplicate ids", () => {
    const ids = ALL_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers every check id exactly once, in FR-5.6 order", () => {
    expect(ALL_CHECKS.map((check) => check.id)).toEqual(EVERY_ID);
  });

  it("is grouped in CHECK_GROUPS order with no interleaving", () => {
    const groups = ALL_CHECKS.map((check) => check.group);
    const firstIndex = CHECK_GROUPS.map((group) => groups.indexOf(group));
    const lastIndex = CHECK_GROUPS.map((group) => groups.lastIndexOf(group));
    expect(firstIndex).toEqual([...firstIndex].sort((a, b) => a - b));
    for (const [position, group] of CHECK_GROUPS.entries()) {
      const start = firstIndex[position] as number;
      const end = lastIndex[position] as number;
      expect(groups.slice(start, end + 1).every((candidate) => candidate === group)).toBe(true);
    }
  });

  it("has a real body for config.stale now that M4 has landed", async () => {
    const check = ALL_CHECKS.find((candidate) => candidate.id === "config.stale");
    expect(check).toBeDefined();
    const result = await (check as NonNullable<typeof check>).run(makeCtx());
    expect(result.level).toBe("pass");
  });

  it("reports the group it was registered under", async () => {
    const ctx = makeCtx();
    for (const check of ALL_CHECKS) {
      const result = await check.run(ctx);
      expect(result.id).toBe(check.id);
      expect(result.group).toBe(check.group);
    }
  });

  it("skips every check whose milestone has not landed", async () => {
    const ctx = makeCtx();
    // M5 owns the workspace leak scan; `config.stale` became real in M4.
    const deferred: CheckId[] = ["cred.leak"];
    for (const id of deferred) {
      const check = ALL_CHECKS.find((candidate) => candidate.id === id);
      expect(check).toBeDefined();
      const result = await (check as NonNullable<typeof check>).run(ctx);
      expect(result.level).toBe("skipped");
      expect(result.fix).toEqual({ kind: "none" });
    }
  });
});
