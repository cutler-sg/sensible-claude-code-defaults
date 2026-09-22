import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

/**
 * Isolation without redirecting HOME.
 *
 * The suite exercises the real read/apply paths, so it needs a Claude
 * directory that is not the developer's. An earlier version got that by
 * redirecting HOME to a temp directory, which had a cost the Linux and
 * Windows legs never showed: on macOS the Electron host blocks during startup
 * under a foreign HOME and never reaches the first test. Pre-seeding
 * `~/Library` under the redirected home did not change that, so it is not a
 * missing-directory problem; whatever macOS consults under the real home
 * during app launch (Keychain, LaunchServices, the sandbox) is not something a
 * test config should be second-guessing.
 *
 * `CLAUDE_CONFIG_DIR` is the isolation mechanism Claude Code itself provides,
 * and `resolveClaudeDir` honours it (plan Q-F). The plain-homedir branch is
 * covered by `test/unit/paths.test.ts` and `test/unit/remoteResolution.test.ts`,
 * which drive the function directly; the integration suite's job is to show
 * the extension reading and writing the directory the *host* resolves, which
 * this still does — see `resolution.spec.ts`, whose expected path is derived
 * from the same variable the host reads.
 */
// Keep the integration profile deliberately hostile to shell interpolation.
// Every host leg then exercises settings reads and permission repair through
// spaces, Unicode and an apostrophe without touching a real user profile.
const claudeDir = mkdtempSync(join(tmpdir(), "scd claude 日本語 O'Brien-"));

/**
 * The extension host's user-data directory, kept short and out of the checkout.
 *
 * VS Code opens a Unix domain socket named `<version>-main.sock` inside this
 * directory, and `sun_path` is capped at 104 bytes on macOS. The default sits
 * at `<repo>/.vscode-test/user-data/`, and on a GitHub runner the repo path is
 * `/Users/runner/work/<repo>/<repo>` — deep enough that the socket path
 * overruns the cap and the host dies on launch with `listen EINVAL` before a
 * single test runs. A `mkdtemp` under the system temp directory is ~40 bytes.
 *
 * Only `user-data-dir` is overridden. `extensions-dir` is left at its default
 * because that is where `@vscode/test-cli` installs the `extensionDependencies`
 * — `anthropic.claude-code` — before launching, and the two have to agree.
 */
const userDataDir = mkdtempSync(join(tmpdir(), "scd-user-data-"));

export default defineConfig({
  files: "out/test/integration-vscode/**/*.spec.js",
  version: "stable",
  workspaceFolder: mkdtempSync(join(tmpdir(), "scd-itest-ws-")),
  launchArgs: [`--user-data-dir=${userDataDir}`],
  env: {
    CLAUDE_CONFIG_DIR: claudeDir,
    // The home of the process launching VS Code. `resolution.spec.ts` uses it
    // to prove the extension never resolved into `~/.claude` of the launcher —
    // which, with HOME no longer redirected, is the developer's real one.
    SCD_LAUNCHER_HOME: homedir(),
  },
  mocha: { ui: "bdd", timeout: 60_000 },
});
