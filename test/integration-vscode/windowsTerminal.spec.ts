/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { WindowsTerminalCli } from "../../src/terminal/windows.js";

describe("native Windows terminal process", () => {
  it("runs the registered bundled executable without an extension-host PATH entry", async function () {
    if (process.platform !== "win32") this.skip();
    const extension = vscode.extensions.getExtension("anthropic.claude-code");
    assert.ok(extension, "Claude Code dependency must be installed");
    const support = new WindowsTerminalCli({
      path: () => "",
      pathExt: () => ".EXE",
      extensionPath: () => extension.extensionPath,
      enabled: () => false,
      stat,
      realpath,
      execFile: promisify(execFileCallback),
      collection: {
        append() {
          assert.fail("direct launch must not mutate PATH");
        },
        delete() {
          assert.fail("direct launch must not mutate PATH");
        },
      },
      pathVariable: "Path",
    });
    const result = await support.prepareLaunch();
    assert.equal(result.kind, "ready", JSON.stringify(result));
    if (result.kind !== "ready") return;
    // --version exits by itself: no credentials, interactive session, or process killing.
    let terminal: vscode.Terminal | undefined;
    const code = await new Promise<number | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        closed.dispose();
        reject(new Error("Claude version terminal did not exit in 20 seconds"));
      }, 20000);
      const closed = vscode.window.onDidCloseTerminal((ended) => {
        if (ended !== terminal) return;
        clearTimeout(timeout);
        closed.dispose();
        resolve(ended.exitStatus?.code);
      });
      try {
        terminal = vscode.window.createTerminal({
          name: "Claude version regression",
          shellPath: result.file,
          shellArgs: ["--version"],
          isTransient: true,
        });
        terminal.show();
      } catch (error) {
        clearTimeout(timeout);
        closed.dispose();
        reject(error);
      }
    });
    assert.equal(code, 0, "the real terminal process must exit successfully");
  });
});
