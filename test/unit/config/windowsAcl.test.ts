/**
 * Plan Q-AG's regression, stated as a test.
 *
 * The fixtures under `test/fixtures/icacls/` are *constructed*, not captured
 * from a live Windows box — see the README there. The English, German and
 * Japanese samples describe the same underlying DACL, so a parser that reads
 * localised display names instead of SIDs makes their verdicts diverge. That
 * divergence is what `it.each` over LOCALES is here to catch: an English-only
 * parser reports a world-readable token file as fine on a German install, and a
 * false all-clear on the file holding the Bedrock key is the worst outcome in
 * this project.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandOutcome, CommandRunner } from "../../../src/config/windowsAcl.js";
import {
  AUTHENTICATED_USERS,
  BUILTIN_USERS,
  EVERYONE,
  ensureWindowsAcl,
  parseDacl,
} from "../../../src/config/windowsAcl.js";

// `__dirname`, not `import.meta.url`: `tsconfig` emits CommonJS for the
// extension bundle, and the meta-property is a compile error under it.
const FIXTURES = path.join(__dirname, "../../fixtures/icacls");

const USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const FILE = String.raw`C:\Users\mcutler\.claude\settings.json`;

/** Read a fixture the way the module does: bytes, decoded by their own BOM. */
async function fixture(name: string): Promise<Buffer> {
  return fs.readFile(path.join(FIXTURES, name));
}

async function fixtureText(name: string): Promise<string> {
  const bytes = await fixture(name);
  return bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
    ? bytes.subarray(2).toString("utf16le")
    : bytes.toString("utf8");
}

const LOCALES = ["en-US", "de-DE", "ja-JP"] as const;

let scratchDir: string;

beforeEach(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "scd-acl-"));
});

afterEach(async () => {
  await fs.rm(scratchDir, { recursive: true, force: true });
});

/**
 * An `icacls` stand-in that answers `/save` by copying a fixture into the
 * scratch path the module chose. Records every call, so the repair path can be
 * asserted on the arguments rather than on a real Windows ACL.
 */
function fakeIcacls(options: {
  save: string | (() => string | undefined);
  /**
   * The *console listing* for the same file, in this host's language. The
   * module never reads it — that is the point — but the fake serves it anyway,
   * so a regression that starts parsing display names gets the realistic,
   * localised input it would get on a real box rather than an empty string.
   * Without this the German and Japanese cases would fail for the wrong
   * reason (no input at all) instead of the right one (wrong language).
   */
  listing?: string | (() => string);
  userSid?: string | undefined;
  missing?: boolean;
}): { run: CommandRunner; calls: { cmd: string; args: readonly string[] }[] } {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "whoami") {
      return options.userSid === undefined
        ? { kind: "ok", code: 1, stdout: "" }
        : { kind: "ok", code: 0, stdout: `"DESKTOP-7F2K1\\mcutler","${options.userSid}"\r\n` };
    }
    if (options.missing === true) {
      return { kind: "missing" };
    }
    const saveAt = args.indexOf("/save");
    if (saveAt !== -1) {
      const name = typeof options.save === "string" ? options.save : options.save();
      const target = args[saveAt + 1] as string;
      if (name !== undefined) {
        await fs.writeFile(target, await fixture(name));
      }
      return {
        kind: "ok",
        code: 0,
        stdout:
          options.listing === undefined
            ? ""
            : await fixtureText(
                typeof options.listing === "string" ? options.listing : options.listing(),
              ),
      };
    }
    return { kind: "ok", code: 0, stdout: "" };
  };
  return { run, calls };
}

describe("parseDacl (plan Q-AG)", () => {
  it.each(LOCALES)("reads the same broad principals from the %s capture", async (locale) => {
    expect(parseDacl(await fixtureText(`${locale}.loose.sddl.txt`))).toEqual([
      "S-1-5-18",
      "S-1-5-32-544",
      USER_SID,
      BUILTIN_USERS,
      EVERYONE,
    ]);
  });

  it.each(LOCALES)("reads a user-only DACL as user-only in %s", async (locale) => {
    const principals = parseDacl(await fixtureText(`${locale}.tight.sddl.txt`));
    expect(principals).toEqual(["S-1-5-18", "S-1-5-32-544", USER_SID]);
    expect(principals).not.toContain(EVERYONE);
    expect(principals).not.toContain(BUILTIN_USERS);
    expect(principals).not.toContain(AUTHENTICATED_USERS);
  });

  it("reads Authenticated Users written as a literal SID, not only as the AU alias", async () => {
    expect(parseDacl(await fixtureText("en-US.loose-sid.sddl.txt"))).toContain(AUTHENTICATED_USERS);
  });

  it("treats a NULL DACL as unrestricted rather than unreadable", async () => {
    // `NO_ACCESS_CONTROL` means every principal has full access. Reporting it
    // as unparseable would turn the loudest possible finding into a shrug.
    expect(parseDacl(await fixtureText("en-US.null-dacl.sddl.txt"))).toEqual([EVERYONE]);
  });

  it("walks past blank lines, file names and a localised summary line", async () => {
    expect(parseDacl(await fixtureText("en-US.messy.sddl.txt"))).toContain(EVERYONE);
  });

  it("survives CRLF, LF and CR alike", () => {
    const sddl = `${FILE}\r\nD:AI(A;ID;FA;;;SY)(A;ID;FA;;;WD)`;
    const expected = ["S-1-5-18", EVERYONE];
    expect(parseDacl(sddl)).toEqual(expected);
    expect(parseDacl(sddl.replaceAll("\r\n", "\n"))).toEqual(expected);
    expect(parseDacl(sddl.replaceAll("\r\n", "\r"))).toEqual(expected);
  });

  it("ignores a deny ACE, which grants nobody anything", () => {
    expect(parseDacl("D:P(D;;FA;;;WD)(A;;FA;;;SY)")).toEqual(["S-1-5-18"]);
  });

  it("counts an ACE type it has never seen as a grant (fails closed)", () => {
    // An unrecognised entry on the token file should make us look, not relax.
    expect(parseDacl("D:P(ZZ;;FA;;;WD)")).toEqual([EVERYONE]);
  });

  it("does not mistake the AU audit ACE type for the Authenticated Users principal", () => {
    // `AU` is SYSTEM_AUDIT in field 0 and Authenticated Users in field 5. The
    // fields are positional, and an audit entry grants nothing.
    expect(parseDacl("D:P(AU;SA;FA;;;SY)")).toEqual([]);
  });

  it("stops at the DACL and does not read the SACL's principals", () => {
    expect(parseDacl("D:P(A;;FA;;;SY)S:(AU;SAFA;FA;;;WD)")).toEqual(["S-1-5-18"]);
  });

  it("returns undefined when there is no access control list at all", () => {
    expect(parseDacl("Successfully processed 0 files; Failed processing 1 files")).toBeUndefined();
    expect(parseDacl("")).toBeUndefined();
  });

  it("never reads the localised console listing", async () => {
    // The name listings are the input a name-matching parser would use. They
    // carry no `D:` descriptor, so this module gets nothing from them — which
    // is the point: it cannot accidentally start depending on display names.
    for (const locale of LOCALES) {
      expect(parseDacl(await fixtureText(`${locale}.loose.names.txt`))).toBeUndefined();
    }
  });

  it("is unaffected by a console codepage mismatch", async () => {
    // Mojibake in the *listing* must not become a verdict; the descriptor is
    // read from `/save`, not from the console.
    expect(parseDacl(await fixtureText("ja-JP.loose.names.mojibake.txt"))).toBeUndefined();
  });
});

describe("ensureWindowsAcl", () => {
  it.each(LOCALES)("passes a user-only file on a %s host", async (locale) => {
    const { run } = fakeIcacls({
      save: `${locale}.tight.sddl.txt`,
      listing: `${locale}.tight.names.txt`,
      userSid: USER_SID,
    });
    expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toEqual({ kind: "aclOk" });
  });

  it.each(LOCALES)(
    "repairs a loosened file on a %s host and reports what it found",
    async (locale) => {
      // The second `/save` — the verification read — has to see the tightened
      // DACL, exactly as a real repair would.
      let reads = 0;
      const { run, calls } = fakeIcacls({
        save: () => (reads++ === 0 ? `${locale}.loose.sddl.txt` : `${locale}.tight.sddl.txt`),
        listing: () => (reads === 1 ? `${locale}.loose.names.txt` : `${locale}.tight.names.txt`),
        userSid: USER_SID,
      });

      expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toEqual({
        kind: "aclRepaired",
        before: [BUILTIN_USERS, EVERYONE],
      });

      const repair = calls.filter((c) => c.cmd === "icacls" && !c.args.includes("/save"));
      expect(repair[0]?.args).toContain("/inheritance:r");
      expect(repair[0]?.args).toContain(`*${USER_SID}:F`);
      // Every broad principal is removed by SID, with the `*` prefix `icacls`
      // requires for a numeric form — never by a display name.
      expect(repair[1]?.args).toEqual(
        expect.arrayContaining([`*${EVERYONE}`, `*${BUILTIN_USERS}`, `*${AUTHENTICATED_USERS}`]),
      );
      for (const call of calls) {
        for (const arg of call.args) {
          expect(arg).not.toMatch(/Everyone|Jeder|BUILTIN|VORDEFINIERT/);
        }
      }
    },
  );

  it("reports every locale's loose capture identically (the Q-AG regression)", async () => {
    const verdicts = await Promise.all(
      LOCALES.map(async (locale) => {
        let reads = 0;
        const { run } = fakeIcacls({
          save: () => (reads++ === 0 ? `${locale}.loose.sddl.txt` : `${locale}.tight.sddl.txt`),
          listing: () => (reads === 1 ? `${locale}.loose.names.txt` : `${locale}.tight.names.txt`),
          userSid: USER_SID,
        });
        return ensureWindowsAcl(FILE, { run, scratchDir });
      }),
    );
    // The same DACL in three languages is one verdict, or the parser is reading
    // display names. Pinned as a positive verdict too, so a parser that found
    // nothing anywhere could not pass this by being uniformly blind.
    expect(verdicts[0]).toEqual({ kind: "aclRepaired", before: [BUILTIN_USERS, EVERYONE] });
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
  });

  it("reports the file as still loose when the repair did not take", async () => {
    const { run } = fakeIcacls({
      save: "en-US.loose.sddl.txt",
      listing: "en-US.loose.names.txt",
      userSid: USER_SID,
    });
    expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toEqual({
      kind: "aclLoose",
      found: [BUILTIN_USERS, EVERYONE],
    });
  });

  it("does not attempt a repair it cannot aim, and says why", async () => {
    // Without the current user's SID the only grant we could write would be a
    // name — the localisation bug Q-AG closed. Better to report it loose.
    const { run, calls } = fakeIcacls({ save: "en-US.loose.sddl.txt", userSid: undefined });
    expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toMatchObject({
      kind: "aclLoose",
      found: [BUILTIN_USERS, EVERYONE],
      reason: expect.stringContaining("current user"),
    });
    expect(calls.some((c) => c.args.includes("/inheritance:r"))).toBe(false);
  });

  it("reports unsupported only when icacls is not there at all", async () => {
    const { run } = fakeIcacls({ save: "en-US.loose.sddl.txt", missing: true });
    expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toEqual({ kind: "unsupported" });
  });

  it("fails closed when icacls runs but writes no descriptor", async () => {
    // Never a pass. "We could not read the ACL" and "the ACL is fine" are
    // different claims, and only one of them is safe to make about this file.
    const run: CommandRunner = async () => ({ kind: "ok", code: 1, stdout: "Access is denied." });
    expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toMatchObject({
      kind: "unverifiable",
    });
  });

  it("fails closed when the descriptor it wrote has no DACL in it", async () => {
    const { run } = fakeIcacls({ save: "en-US.loose.names.txt", userSid: USER_SID });
    expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toMatchObject({
      kind: "unverifiable",
      reason: expect.stringContaining("access control list"),
    });
  });

  it("leaves no scratch descriptor behind, on either path", async () => {
    const { run } = fakeIcacls({ save: "en-US.tight.sddl.txt", userSid: USER_SID });
    await ensureWindowsAcl(FILE, { run, scratchDir });
    const failing: CommandRunner = async () => ({ kind: "ok", code: 5, stdout: "" });
    await ensureWindowsAcl(FILE, { run: failing, scratchDir });
    expect(await fs.readdir(scratchDir)).toEqual([]);
  });

  it("asks icacls to keep going past an error and to stay quiet", async () => {
    const { run, calls } = fakeIcacls({ save: "en-US.tight.sddl.txt", userSid: USER_SID });
    await ensureWindowsAcl(FILE, { run, scratchDir });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["/q", "/c"]));
  });

  it("decodes UTF-16LE, UTF-16BE, UTF-8-with-BOM and bare UTF-8 descriptors alike", async () => {
    const sddl = `${FILE}\r\nD:AI(A;ID;FA;;;WD)\r\n`;
    const encodings: Buffer[] = [
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sddl, "utf16le")]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(sddl, "utf16le").swap16()]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sddl, "utf8")]),
      Buffer.from(sddl, "utf8"),
    ];
    for (const bytes of encodings) {
      const run: CommandRunner = async (cmd, args): Promise<CommandOutcome> => {
        if (cmd === "whoami") return { kind: "ok", code: 1, stdout: "" };
        const saveAt = args.indexOf("/save");
        if (saveAt !== -1) await fs.writeFile(args[saveAt + 1] as string, bytes);
        return { kind: "ok", code: 0, stdout: "" };
      };
      expect(await ensureWindowsAcl(FILE, { run, scratchDir })).toMatchObject({
        kind: "aclLoose",
        found: [EVERYONE],
      });
    }
  });
});
