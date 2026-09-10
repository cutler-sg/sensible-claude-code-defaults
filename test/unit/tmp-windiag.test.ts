import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";

// TEMPORARY diagnostic, removed once the Windows symlink semantics are known.
describe.runIf(process.platform === "win32")("windows path diagnostics", () => {
  it("prints what resolution actually does", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scd-diag-"));
    const workspace = path.join(dir, "proj");
    const real = path.join(workspace, ".claude");
    await fs.mkdir(real, { recursive: true });
    const home = path.join(dir, "home");
    await fs.mkdir(home);
    const link = path.join(home, ".claude");
    let symlinkError = "none";
    try {
      await fs.symlink(real, link, "dir");
    } catch (e) {
      symlinkError = String((e as Error).message);
    }
    const target = path.join(link, "settings.json");
    const out: Record<string, string> = {
      tmpdir: os.tmpdir(),
      dir,
      workspace,
      symlinkError,
      workspaceRealpath: await fs.realpath(workspace).catch((e) => `ERR ${e.code}`),
      linkRealpath: await fs.realpath(link).catch((e) => `ERR ${e.code}`),
      targetRealpath: await fs.realpath(target).catch((e) => `ERR ${e.code}`),
      parentRealpath: await fs.realpath(path.dirname(target)).catch((e) => `ERR ${e.code}`),
      lstatIsSymlink: String((await fs.lstat(link)).isSymbolicLink()),
    };
    console.log(`WINDIAG ${JSON.stringify(out)}`);
  });
});
