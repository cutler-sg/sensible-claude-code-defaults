import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

/**
 * A throwaway HOME per run.
 *
 * The suite exercises the real read/apply paths, so it needs a home directory
 * that is not the developer's. It used to get that by setting
 * `CLAUDE_CONFIG_DIR` — which isolated the run, but at the cost of steering
 * every test down the one branch of `resolveClaudeDir` that FR-1.2 does *not*
 * describe. Redirecting the home instead isolates just as completely and leaves
 * `path.join(os.homedir(), '.claude')` — the path a real user takes, and the
 * one `resolution.spec.ts` is about — as the thing under test.
 *
 * `USERPROFILE` is set alongside `HOME` because that is what `os.homedir()`
 * reads on Windows.
 */
const home = mkdtempSync(join(tmpdir(), "scd-home-"));

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
    HOME: home,
    USERPROFILE: home,
    // Explicitly cleared, not merely unset: a developer who exports
    // CLAUDE_CONFIG_DIR in their shell would otherwise have the suite read and
    // rewrite their real Claude Code configuration. `spawn` drops keys whose
    // value is `undefined`, which is how the value is removed rather than
    // blanked.
    CLAUDE_CONFIG_DIR: undefined,
    // The home of the process *launching* VS Code, recorded before the
    // redirection above takes effect. `resolution.spec.ts` uses it to prove the
    // extension resolved against the host's own home rather than the launcher's.
    SCD_LAUNCHER_HOME: homedir(),
  },
  mocha: { ui: "bdd", timeout: 60_000 },
});
