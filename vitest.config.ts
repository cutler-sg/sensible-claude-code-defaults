import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Windows runners are slow at filesystem-heavy tests: a full apply-then-
    // restore round trip (two atomic writes, a backup copy, an ACL read via
    // icacls) ran past vitest's 5s default once and passed on the re-run,
    // taking ~110ms on Linux. Fifteen seconds is far above any real cost and
    // far below a hang, and a flaky required check is worse than either.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Thresholds land in M1, when src/config/ exists and is worth gating on.
      thresholds: undefined,
    },
  },
});
