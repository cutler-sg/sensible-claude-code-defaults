import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Thresholds land in M1, when src/config/ exists and is worth gating on.
      thresholds: undefined,
    },
  },
});
