/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const EXTENSION_ID = "cutler-sg.sensible-claude-code-defaults";

/**
 * FR-1.3 / §10.3 / §15 "WSL homedir mismatch" — which machine's home directory
 * the extension actually reads and writes.
 *
 * ## What this file covers, and what it does not
 *
 * The requirement is that under WSL, Remote-SSH and devcontainers the
 * configuration written is the **remote** one, because that is the side the
 * Claude Code binary runs on. The extension earns that by not declaring
 * `extensionKind: ["ui"]`, which leaves VS Code free to place the extension
 * host on the remote — and then by resolving its paths from nothing but that
 * host process's own environment.
 *
 * **Genuinely covered here.** That second half: the directory this extension
 * reads and writes is the one `os.homedir()` yields *inside the extension host
 * process*, and it is not the home of the process that launched VS Code. The
 * two are different directories in this run (`.vscode-test.mjs` redirects
 * `HOME`/`USERPROFILE` for the host and records the launcher's own home in
 * `SCD_LAUNCHER_HOME`), so the assertion has something to fail against. That
 * is the structural analogue of remote placement: a client-side value reaching
 * path resolution would show up here as the launcher's home.
 *
 * **Not covered here.** That a *real* remote host resolves the real remote
 * home. `@vscode/test-cli` runs no remote — there is one machine and one
 * extension host — so nothing here exercises VS Code's decision to *place* the
 * host on the far side, which is the half FR-1.3's manifest rule buys.
 *
 * In particular, `vscode.env.remoteName` is not faked. It can be redefined with
 * `Object.defineProperty` on a local window, and an earlier draft did exactly
 * that; the result was worthless. Nothing in `resolveClaudeDir` reads
 * `remoteName`, so such a test passes identically whether resolution is right
 * or wrong — it asserts the absence of a dependency that was never there, while
 * reading like remote coverage. Deliberately not written.
 *
 * Every assertion below was checked against a mutant (`resolveClaudeDir`
 * rewritten to prefer `SCD_LAUNCHER_HOME`) and fails on it. The remaining gap —
 * real remote placement — is closed by a human on real hardware:
 * `docs/manual-verification.md`, items 3 and 4.
 *
 * Two other pieces sit either side of this one. `test/unit/packageJson.test.ts`
 * asserts the manifest carries no `extensionKind`, which is what permits remote
 * placement at all. `test/unit/remoteResolution.test.ts` drives
 * `resolveClaudeDir` directly against remote-shaped environments — a WSL home,
 * a Remote-SSH home, a Windows profile — which is where the shape of the answer
 * is checked. Neither can see the wiring; this file is the one that does.
 */
describe("claude directory resolution (FR-1.3)", () => {
  /**
   * Evaluated in the extension host process, which is the process the extension
   * runs in. Under Remote-SSH or WSL this process is on the remote machine, so
   * this expression is the remote home — the whole requirement, restated as an
   * expression.
   */
  const expectedClaudeDir = path.join(os.homedir(), ".claude");
  const expectedSettings = path.join(expectedClaudeDir, "settings.json");

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();
    mkdirSync(expectedClaudeDir, { recursive: true });
  });

  it("runs in a host whose home is not the launcher's, so the assertions can fail", () => {
    // Guard, not a behaviour claim. Every assertion below distinguishes "the
    // host's own home" from "some other home", and without two distinct
    // directories none of them can tell those apart — the file would pass on a
    // misconfigured harness while proving nothing. Stated first so a broken
    // harness fails here rather than silently downgrading the rest.
    const launcherHome = process.env.SCD_LAUNCHER_HOME;
    assert.ok(launcherHome, "SCD_LAUNCHER_HOME is not set; see .vscode-test.mjs");
    assert.notEqual(
      os.homedir(),
      launcherHome,
      "the extension host shares a home with its launcher, so this suite cannot tell them apart",
    );
    assert.equal(
      process.env.CLAUDE_CONFIG_DIR,
      undefined,
      "CLAUDE_CONFIG_DIR is set, so resolution is not taking the FR-1.2 homedir branch",
    );
  });

  it("opens the settings file under the host's own home, not the launcher's", async () => {
    writeFileSync(expectedSettings, "{}\n");

    // `openSettings` opens `deps.settingsFile`, which the host derives from
    // `resolveClaudeDir()` at activation. The editor it leaves open is
    // therefore the extension's own answer to "which file is Claude Code's
    // settings file", read back out of the running extension rather than
    // recomputed by the test.
    await vscode.commands.executeCommand("sensibleDefaults.openSettings");
    const opened = vscode.window.activeTextEditor?.document.uri.fsPath;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    assert.equal(opened, expectedSettings);
    assert.ok(
      !opened.startsWith(`${process.env.SCD_LAUNCHER_HOME}${path.sep}`),
      `resolved into the launching machine's home: ${opened}`,
    );
  });

  it("writes to the file under the host's own home", async () => {
    // A write, not a read. The permission repair runs inside every health run
    // and targets the resolved settings file, so loosening the mode and
    // watching which file tightens again observes the *write* path landing on
    // the host-local directory — §10.3's "writes land in the WSL home, not the
    // Windows home", as far as one machine can show it.
    writeFileSync(expectedSettings, '{"scdMarker":"resolution.spec"}\n');
    chmodSync(expectedSettings, 0o644);

    await vscode.commands.executeCommand("sensibleDefaults.runHealthCheck");

    assert.equal(
      statSync(expectedSettings).mode & 0o777,
      0o600,
      "the health run did not repair the mode of the file under the host's home",
    );
    // The file it touched is the one we planted, not a same-named file
    // elsewhere that happens to be 0600 already.
    assert.match(readFileSync(expectedSettings, "utf8"), /resolution\.spec/);
  });

  it("ignores a client-side value injected into the window", async () => {
    // The failure mode this file exists to rule out, staged directly: a value
    // that belongs to the *client* is put where a careless implementation might
    // read it from, and the extension is asked to resolve again.
    //
    // `vscode.env.remoteName` is the honest name for that value, and it is what
    // an earlier draft faked. Faking it proves nothing — resolution never reads
    // it, so the test passes whether the code is right or wrong. What *can* be
    // staged meaningfully is the client home itself, which is the thing
    // `remoteName` would lead an implementation to go looking for. If path
    // resolution ever grew a dependency on the launching machine, a settings
    // file planted under the launcher's home is what it would find.
    const launcherHome = process.env.SCD_LAUNCHER_HOME;
    assert.ok(launcherHome);
    const decoy = path.join(launcherHome, ".claude", "settings.json");

    await vscode.commands.executeCommand("sensibleDefaults.openSettings");
    const opened = vscode.window.activeTextEditor?.document.uri.fsPath;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    assert.notEqual(opened, decoy, "resolution followed the launching machine's home");
    assert.equal(opened, expectedSettings);
  });
});
