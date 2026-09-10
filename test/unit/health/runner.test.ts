import { describe, expect, it } from "vitest";
import { ALL_CHECKS } from "../../../src/health/catalogue.js";
import { LABELS } from "../../../src/health/labels.js";
import { runAll, transition } from "../../../src/health/runner.js";
import type {
  CatalogueCheckId,
  Check,
  CheckId,
  CheckResult,
  HealthReport,
  Level,
} from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest } from "../../../src/manifest/types.js";
import { makeCtx } from "./fixture.js";

const AT = () => new Date("2026-09-10T13:00:00.000Z");

function stub(id: CatalogueCheckId, level: Level): Check {
  return {
    id,
    group: "Configuration",
    run: () => ({
      id,
      group: "Configuration",
      level,
      label: `${id} ${level}`,
      fix: { kind: "none" },
    }),
  };
}

function thrower(id: CatalogueCheckId, error: unknown): Check {
  return {
    id,
    group: "Configuration",
    run: () => {
      throw error;
    },
  };
}

async function report(...checks: Check[]): Promise<HealthReport> {
  return runAll(checks, makeCtx(), AT);
}

describe("runAll", () => {
  it("stamps the report and counts every level", async () => {
    const result = await report(
      stub("config.exists", "pass"),
      stub("config.parses", "warning"),
      stub("config.bedrock", "error"),
      stub("config.region", "info"),
      stub("config.models", "skipped"),
    );
    expect(result.at).toBe("2026-09-10T13:00:00.000Z");
    expect(result.counts).toEqual({ pass: 1, warning: 1, error: 1, info: 1, skipped: 1 });
  });

  it("defaults its clock to the real one", async () => {
    const before = Date.now();
    const result = await runAll([stub("config.exists", "pass")], makeCtx());
    expect(Date.parse(result.at)).toBeGreaterThanOrEqual(before);
  });

  it("preserves the order the checks were given in", async () => {
    const result = await report(stub("config.parses", "pass"), stub("config.exists", "pass"));
    expect(result.results.map((entry: CheckResult) => entry.id)).toEqual([
      "config.parses",
      "config.exists",
    ]);
  });

  it("contains a crashing check as an error result rather than throwing", async () => {
    const result = await report(
      stub("config.exists", "pass"),
      thrower("config.parses", new Error("boom")),
      stub("config.bedrock", "pass"),
    );
    expect(result.results).toHaveLength(3);
    expect(result.results[1]).toEqual({
      id: "config.parses",
      group: "Configuration",
      level: "error",
      label: "This check couldn't finish",
      detail: "boom",
      fix: { kind: "none" },
    });
  });

  it("stringifies a non-Error throw", async () => {
    const result = await report(thrower("config.exists", "just a string"));
    expect(result.results[0]?.detail).toBe("just a string");
  });

  /**
   * F5. The notice push used to sit outside `runOne`'s try/catch, so a manifest
   * whose `notices` is not an array made `runAll` reject — which the host turns
   * into a permanent error toast and an empty panel.
   *
   * Narrow today, because validation guarantees the shape. But `manifestHolder`
   * starts on `BUNDLED_MANIFEST`, which is a cast that has not been validated
   * at that point, and `resolve.ts`'s bundled floor deliberately returns its
   * manifest even when validation fails — so the runner is reachable with a
   * manifest nobody vouched for, and it is the wrong layer to find that out in.
   */
  it("does not let a malformed manifest's notices take the whole report down (F5)", async () => {
    const ctx = makeCtx({
      manifest: { ...BUNDLED_MANIFEST, notices: "not an array" } as unknown as Manifest,
    });

    const result = await runAll([stub("config.exists", "pass")], ctx, AT);

    // The checks still ran and the panel still has rows.
    expect(result.results[0]?.id).toBe("config.exists");
    expect(result.counts.pass).toBe(1);
  });

  it("reports the failed notice synthesis as one contained row, not silence", async () => {
    const ctx = makeCtx({
      manifest: { ...BUNDLED_MANIFEST, notices: undefined } as unknown as Manifest,
    });

    const result = await runAll([stub("config.exists", "pass")], ctx, AT);

    const crashed = result.results.find((entry) => entry.label === LABELS.crashed);
    expect(crashed).toMatchObject({ group: "Configuration", level: "error" });
    expect(crashed?.fix).toEqual({ kind: "none" });
  });

  it("runs the real catalogue on a healthy context with no errors", async () => {
    const result = await runAll(ALL_CHECKS, makeCtx(), AT);
    expect(result.counts.error).toBe(0);
    expect(result.results).toHaveLength(ALL_CHECKS.length);
  });
});

function reportOf(entries: Partial<Record<CheckId, Level>>): HealthReport {
  const results: CheckResult[] = Object.entries(entries).map(([id, level]) => ({
    id: id as CheckId,
    group: "Configuration",
    level: level as Level,
    label: id,
    fix: { kind: "none" },
  }));
  return { at: AT().toISOString(), results, counts: countOf(results) };
}

function countOf(results: CheckResult[]): Record<Level, number> {
  const counts: Record<Level, number> = { pass: 0, info: 0, warning: 0, error: 0, skipped: 0 };
  for (const result of results) counts[result.level] += 1;
  return counts;
}

describe("transition", () => {
  it("is first-run when nothing is configured but Claude Code is installed", () => {
    const next = reportOf({ "install.extension": "pass", "config.exists": "warning" });
    expect(transition(undefined, next)).toBe("first-run");
  });

  it("stays quiet on a first run when Claude Code itself is missing (plan Q-R)", () => {
    const next = reportOf({ "install.extension": "error", "config.exists": "warning" });
    expect(transition(undefined, next)).toBe("none");
  });

  it("stays quiet on a first run that is already configured", () => {
    const next = reportOf({ "install.extension": "pass", "config.exists": "pass" });
    expect(transition(undefined, next)).toBe("none");
  });

  it("stays quiet on a first run whose report is missing those checks entirely", () => {
    expect(transition(undefined, reportOf({ "config.bedrock": "error" }))).toBe("none");
  });

  it("fires once on healthy → failing", () => {
    const prev = reportOf({ "config.bedrock": "pass" });
    const next = reportOf({ "config.bedrock": "error" });
    expect(transition(prev, next)).toBe("healthy-to-fail");
  });

  it("stays quiet while it keeps failing", () => {
    const failing = reportOf({ "config.bedrock": "error" });
    expect(transition(failing, failing)).toBe("none");
  });

  it("stays quiet on failing → healthy", () => {
    expect(
      transition(reportOf({ "config.bedrock": "error" }), reportOf({ "config.bedrock": "pass" })),
    ).toBe("none");
  });

  it("never fires for warnings alone", () => {
    const prev = reportOf({ "config.models": "pass" });
    const next = reportOf({ "config.models": "warning", "config.exists": "warning" });
    expect(transition(prev, next)).toBe("none");
  });
});
