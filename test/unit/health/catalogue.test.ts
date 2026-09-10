import { describe, expect, it } from "vitest";
import { ALL_CHECKS } from "../../../src/health/catalogue.js";
import type { CheckId } from "../../../src/health/types.js";
import { CHECK_GROUPS } from "../../../src/health/types.js";
import { daysAgo, makeCtx, NOW, okCredential } from "./fixture.js";

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

  /**
   * M5 landed `cred.leak`, the last deferred check — so the placeholder
   * assertion becomes its inverse: nothing in the catalogue is a stub, and a
   * check added later cannot be left as one silently.
   *
   * "Not a stub" is not "never skips". Several checks skip on an unmet
   * precondition, which is a real answer — `cred.valid` skips until the user
   * runs a test call, by design (plan Q-T). So the context here has *every*
   * precondition met: a key that has been tested, and a leak scan that
   * finished. A skip against that is a check that does nothing.
   */
  it("has no check left unimplemented", async () => {
    const ctx = makeCtx({
      credential: okCredential({
        lastTest: {
          at: NOW.toISOString(),
          tokenSetAt: daysAgo(1),
          result: { kind: "ok", model: "us.anthropic.claude-haiku-4-5" },
        },
        leakScan: { kind: "clean" },
      }),
    });

    const stubs: CheckId[] = [];
    for (const check of ALL_CHECKS) {
      const result = await check.run(ctx);
      if (result.level === "skipped") stubs.push(check.id);
    }

    expect(stubs).toEqual([]);
  });

  /** The check M5 replaced, named so its regression is a named failure. */
  it("runs the workspace leak scan rather than deferring it (FR-4.8)", async () => {
    const ctx = makeCtx({ credential: okCredential({ leakScan: { kind: "clean" } }) });
    const check = ALL_CHECKS.find((candidate) => candidate.id === "cred.leak");

    expect(check).toBeDefined();
    const result = await (check as NonNullable<typeof check>).run(ctx);

    expect(result.level).toBe("pass");
  });
});
