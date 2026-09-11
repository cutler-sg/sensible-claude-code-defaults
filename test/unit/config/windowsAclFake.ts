/**
 * A deterministic `icacls` for tests that cross a platform boundary.
 *
 * The UI and health suites run on all three CI legs, and on Windows they take
 * the real ACL path. Left to a real spawn they would depend on whatever DACL
 * the runner's temp directory happens to carry — which varies by runner image
 * and by whether the job is elevated — so a test asserting "the repair ran"
 * would be green or red for reasons that have nothing to do with the code.
 *
 * Injecting this through `ConfigEnv.acl` makes the Windows path behave
 * identically on every host: a file starts world-readable, a repair makes it
 * user-only, and the verdicts follow. `test/unit/config/windowsAcl.test.ts`
 * is where the parser meets real (constructed) `icacls` output; this is only
 * about giving the layers above it a stable answer.
 */

import * as fs from "node:fs/promises";
import type { CommandRunner, WindowsAclDeps } from "../../../src/config/windowsAcl.js";

const USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const LOOSE = `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER_SID})(A;ID;0x1200a9;;;WD)`;
const TIGHT = `D:PAI(A;;FA;;;SY)(A;;FA;;;${USER_SID})`;

export interface AclFake {
  /** Pass as `ConfigEnv.acl` or `WriteOptions.acl`. */
  deps: Required<Pick<WindowsAclDeps, "run" | "scratchDir">>;
  /** Every non-`/save` `icacls` invocation, in order. */
  readonly repairs: readonly (readonly string[])[];
}

/**
 * @param scratchDir where the `/save` descriptor may be written — the test's
 *   own temp directory, never the settings directory.
 * @param tight start with a user-only DACL (nothing to repair) instead of a
 *   world-readable one.
 */
export function aclFake(scratchDir: string, tight = false): AclFake {
  const state = { tight };
  const repairs: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    if (cmd === "whoami") {
      return { kind: "ok", code: 0, stdout: `"HOST\\me","${USER_SID}"\r\n` };
    }
    const saveAt = args.indexOf("/save");
    if (saveAt !== -1) {
      const sddl = `C:\\settings.json\r\n${state.tight ? TIGHT : LOOSE}\r\n`;
      // UTF-16LE with a BOM, as `icacls /save` writes it.
      await fs.writeFile(
        args[saveAt + 1] as string,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sddl, "utf16le")]),
      );
      return { kind: "ok", code: 0, stdout: "" };
    }
    repairs.push([...args]);
    state.tight = true;
    return { kind: "ok", code: 0, stdout: "" };
  };
  return { deps: { run, scratchDir }, repairs };
}
