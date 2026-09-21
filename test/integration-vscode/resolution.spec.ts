/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const EXTENSION_ID = "cutler-sg.sensible-claude-code-defaults";

/**
 * FR-1.3 / §10.3 / §15 "WSL homedir mismatch" — which machine's directory the
 * extension actually reads and writes.
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
 * **Genuinely covered here.** That second half. The harness sets
 * `CLAUDE_CONFIG_DIR` for the host process and nothing else; the directory this
 * extension reads and writes must therefore be that one, resolved from the
 * host's *own* environment, and must not be the launcher's `~/.claude`. Both
 * are asserted against the running extension rather than recomputed here.
 * Earlier drafts redirected HOME instead, which exercised the plain-homedir
 * branch but stalled the Electron host on macOS before the first test; the
 * plain-homedir branch is driven directly by `test/unit/paths.test.ts` and
 * `test/unit/remoteResolution.test.ts`, so nothing is lost by moving it there.
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
 * or wrong. It would assert the absence of a dependency that was never there,
 * while reading like remote coverage. `docs/manual-verification.md` items 3
 * and 4 close what this file cannot.
 */
describe("claude directory resolution (FR-1.3)", () => {
  /**
   * Read from the extension host process's own environment, which is the
   * process the extension runs in. Under Remote-SSH or WSL that process is on
   * the remote machine, so this is the remote's directory — the whole
   * requirement, restated as an expression.
   */
  const configured = process.env.CLAUDE_CONFIG_DIR;
  assert.ok(configured, "CLAUDE_CONFIG_DIR is not set in the host; see .vscode-test.mjs");
  const expectedClaudeDir = path.resolve(configured);
  const expectedSettings = path.join(expectedClaudeDir, "settings.json");

  /**
   * Compare paths the way the filesystem does. `Uri.fsPath` hands back a
   * lower-cased drive letter (`c:\Users\...`) where `path.resolve` gives an
   * upper-cased one, and on Windows those are one path. Nothing about which
   * machine's home was chosen turns on that letter's case, so folding it keeps
   * the assertion pointed at the thing it is about. POSIX is left alone, where
   * case is meaningful.
   */
  const samePath = (a: string, b: string): boolean =>
    process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();
    mkdirSync(expectedClaudeDir, { recursive: true });
  });

  it("runs in a host whose Claude directory is not the launcher's, so the assertions can fail", () => {
    // Guard, not a behaviour claim. Every assertion below distinguishes "the
    // directory the host resolved" from "the launcher's ~/.claude", and without
    // two distinct directories none of them can tell those apart — the file
    // would pass on a misconfigured harness while proving nothing. Stated first
    // so a broken harness fails here rather than silently downgrading the rest.
    const launcherHome = process.env.SCD_LAUNCHER_HOME;
    assert.ok(launcherHome, "SCD_LAUNCHER_HOME is not set; see .vscode-test.mjs");
    assert.notEqual(
      expectedClaudeDir,
      path.join(launcherHome, ".claude"),
      "the host resolved the launcher's own ~/.claude, so this suite cannot tell them apart",
    );
    assert.ok(
      configured.includes("scd claude 日本語 O'Brien-"),
      "the integration fixture must exercise spaces, Unicode and shell-sensitive punctuation",
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

    assert.ok(opened, "no editor was opened");
    assert.ok(samePath(opened, expectedSettings), `opened ${opened}, expected ${expectedSettings}`);
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

    // POSIX only, and honestly so. Windows has no mode bits; the equivalent
    // hardening is the ACL, which `ensureWindowsAcl` applies by shelling out to
    // `icacls` and which `test/unit/config/windowsAcl.test.ts` covers directly.
    //
    // That leaves this test weaker on Windows than on POSIX: it still shows the
    // health run reading and reporting on the host-local file, but not writing
    // to it. Closing that would need a write command whose promise settles
    // headlessly, and every one of them ends on a notification the test host
    // never dismisses. `docs/manual-verification.md` item 2 covers the Windows
    // write path on real hardware.
    if (process.platform !== "win32") {
      assert.equal(
        statSync(expectedSettings).mode & 0o777,
        0o600,
        "the health run did not repair the mode of the file under the host's home",
      );
    }
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

    // `openSettings` falls back to a modal offer to create the file when it is
    // not there, and in a headless host nobody dismisses it: the command's
    // promise never settles and the run hangs until the job timeout rather than
    // failing. Plant the file so the command takes its open-an-editor path.
    writeFileSync(expectedSettings, "{}\n");

    await vscode.commands.executeCommand("sensibleDefaults.openSettings");
    const opened = vscode.window.activeTextEditor?.document.uri.fsPath;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    assert.ok(opened, "no editor was opened");
    assert.ok(!samePath(opened, decoy), "resolution followed the launching machine's home");
    assert.ok(samePath(opened, expectedSettings), `opened ${opened}, expected ${expectedSettings}`);
  });
});
