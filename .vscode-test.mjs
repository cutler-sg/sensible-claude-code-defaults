import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

// A throwaway CLAUDE_CONFIG_DIR per run: the smoke test exercises the real
// read/apply paths, and pointing them at the developer's own ~/.claude would
// make the suite rewrite the config of whoever ran it.
const claudeDir = mkdtempSync(join(tmpdir(), "scd-itest-"));

export default defineConfig({
  files: "out/test/integration-vscode/**/*.spec.js",
  version: "stable",
  workspaceFolder: mkdtempSync(join(tmpdir(), "scd-itest-ws-")),
  env: { CLAUDE_CONFIG_DIR: claudeDir },
  mocha: { ui: "bdd", timeout: 60_000 },
  launchArgs: ["--disable-extensions-except=cutler.sensible-claude-code-defaults"],
});
