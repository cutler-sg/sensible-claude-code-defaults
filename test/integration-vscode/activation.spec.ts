/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "cutler-sg.sensible-claude-code-defaults";

/**
 * Smoke test only: that the extension activates in a real host, that the view
 * and commands it contributes actually exist, and that running the health check
 * twice does not throw. Behaviour lives in the unit suites — an Electron run is
 * the wrong place to assert it, and a spy on `window.showInformationMessage`
 * cannot see a notification the host renders out of process.
 */
describe("activation", () => {
  it("the extension activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it("it contributes every command it registers", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const id of [
      "sensibleDefaults.runHealthCheck",
      "sensibleDefaults.applyDefaults",
      "sensibleDefaults.checkForUpdates",
      "sensibleDefaults.openSettings",
      "sensibleDefaults.restoreBackup",
      "sensibleDefaults.copyDiagnostics",
      "sensibleDefaults.openLeakedFile",
      "sensibleDefaults.selectRegion",
      "sensibleDefaults.repairPermissions",
      "sensibleDefaults.resetKey",
      "sensibleDefaults.runFix",
      "sensibleDefaults.setToken",
      "sensibleDefaults.rotateToken",
      "sensibleDefaults.clearToken",
      "sensibleDefaults.testConnection",
      "sensibleDefaults.adoptToken",
      "sensibleDefaults.reapplyToken",
      "sensibleDefaults.resolveTokenConflict",
    ]) {
      assert.ok(commands.has(id), `${id} was not registered`);
    }
  });

  it("a health check runs, and running it again is uneventful", async () => {
    await vscode.commands.executeCommand("sensibleDefaults.runHealthCheck");
    await vscode.commands.executeCommand("sensibleDefaults.runHealthCheck");
  });

  /**
   * `checkForUpdates` is deliberately not executed here, and neither is any
   * other command that ends on a notification. `showInformationMessage`
   * resolves when the user dismisses the toast, and in a headless host nobody
   * does — the command's promise simply never settles and the test times out.
   * Its behaviour is covered in `test/unit/ui/commands.test.ts`, where the
   * dialogue is the thing under test rather than an obstacle to it.
   */
});
