import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { assertOutsideWorkspace } from "../../src/config/paths.js";
import { writeRawAtomic } from "../../src/config/writer.js";

// TEMPORARY diagnostic, removed once the Windows guard behaviour is known.
describe.runIf(process.platform === "win32")("windows guard diagnostics", () => {
  it("prints what the guard sees", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scd-diag-"));
    const workspace = path.join(dir, "proj");
    const real = path.join(workspace, ".claude");
    await fs.mkdir(real, { recursive: true });
    const home = path.join(dir, "home");
    await fs.mkdir(home);
    const link = path.join(home, ".claude");
    await fs.symlink(real, link, "dir");
    const target = path.join(link, "settings.json");

    const resolvedParent = await fs.realpath(path.dirname(target));
    const resolvedTarget = path.join(resolvedParent, path.basename(target));

    const probe = (label: string, t: string, folders: string[]) => {
      try {
        assertOutsideWorkspace(t, folders);
        return `${label}=ALLOWED`;
      } catch (e) {
        return `${label}=REFUSED(${(e as { code?: string }).code})`;
      }
    };

    let writeOutcome = "resolved";
    try {
      await writeRawAtomic(target, "{}\n", { workspaceFolders: [workspace] });
    } catch (e) {
      writeOutcome = `threw ${(e as { code?: string }).code}`;
    }

    console.log(
      `WINDIAG2 ${JSON.stringify({
        workspace,
        target,
        resolvedTarget,
        workspaceRealpath: await fs.realpath(workspace),
        literal: probe("literal", target, [workspace]),
        resolved: probe("resolved", resolvedTarget, [workspace]),
        writeOutcome,
        landedInWorkspace: await fs.readdir(real),
      })}`,
    );
  });
});
