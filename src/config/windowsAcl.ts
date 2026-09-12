/**
 * Windows half of FR-2.8 (plan Q-K, closed by Q-AF and Q-AG).
 *
 * POSIX mode bits do not exist on Windows, so `settings.json` — the file that
 * holds the Bedrock bearer token — inherits whatever DACL `%USERPROFILE%`
 * carries. That is *usually* user-only. "Usually" is not a security property,
 * so this module reads the DACL, reports whether a broad principal can read the
 * file, and tightens it when one can.
 *
 * ## Q-AF: why a spawn and not a native module
 *
 * A native ACL binding has to match VS Code's Electron ABI on every host the
 * extension runs on (the stack rule forbids native modules outright). `icacls`
 * ships with Windows and a spawn has no ABI.
 *
 * ## Q-AG: why the DACL is read as SDDL and never as names
 *
 * `icacls <file>` prints *resolved display names* — `Everyone`, `BUILTIN\Users`
 * — and those names are localised. On a German install the same ACE prints as
 * `Jeder` and `VORDEFINIERT\Benutzer`; on a Japanese install as `Everyone` and
 * `BUILTIN\Users` with localised rights annotations around them. An English-only
 * parser therefore finds nothing and reports a world-readable token file as
 * fine — a false all-clear, in the one place a false all-clear costs the most.
 *
 * So the DACL is not read from that listing at all. `icacls <file> /save` writes
 * the security descriptor in SDDL, where every principal is either a literal SID
 * (`S-1-5-21-…`) or a two-letter SDDL alias (`WD`, `BU`, `AU`) — both fixed
 * ASCII defined by the SDDL grammar, identical on every locale. `test/unit/
 * config/windowsAcl.test.ts` pins that: the German and Japanese captures must
 * produce the same verdict as the English one for the same underlying ACL.
 *
 * Detection fails *closed*. An `icacls` that runs but yields no descriptor we
 * can parse reports `unverifiable`, which the panel shows as a warning with a
 * diagnostic action — never as a pass. Only `icacls` being absent entirely is
 * `unsupported`, and that is the one state where there is genuinely nothing to
 * say.
 */

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Past this, an ACL answer is not worth the wait; the caller is a health check. */
const ICACLS_TIMEOUT_MS = 5000;

/**
 * The principals that must not hold a grant on the token file.
 *
 * SIDs, not names, and well-known ones: these three are constant across every
 * Windows installation and every language pack (Q-AG).
 */
export const EVERYONE = "S-1-1-0";
export const BUILTIN_USERS = "S-1-5-32-545";
export const AUTHENTICATED_USERS = "S-1-5-11";

export const BROAD_PRINCIPALS: readonly string[] = [EVERYONE, BUILTIN_USERS, AUTHENTICATED_USERS];

/**
 * SDDL renders well-known principals as two-letter aliases rather than SIDs, so
 * the alias table is part of reading a SID, not a convenience. Only the aliases
 * that can resolve to a broad principal need to be here — anything else stays
 * whatever `icacls` wrote and simply fails to match.
 *
 * `AU` is deliberately listed: in the *principal* field it is Authenticated
 * Users, and in the *ACE type* field the same two letters mean SYSTEM_AUDIT.
 * The fields are positional, so reading the principal from position 5 keeps the
 * two apart without a special case.
 */
const SDDL_ALIASES: Readonly<Record<string, string>> = {
  WD: EVERYONE,
  BU: BUILTIN_USERS,
  AU: AUTHENTICATED_USERS,
  AN: "S-1-5-7",
  IU: "S-1-5-4",
  SY: "S-1-5-18",
  BA: "S-1-5-32-544",
  CO: "S-1-3-0",
  OW: "S-1-3-4",
};

/**
 * SDDL ACE types that are *not* a grant of access.
 *
 * Stated as the exclusion rather than the inclusion so an ACE type we have
 * never seen counts as a grant: an unrecognised entry on the token file should
 * make us look, not make us relax (fail closed).
 */
const NON_GRANT_ACE_TYPES: ReadonlySet<string> = new Set(["D", "OD", "XD", "AU", "AL", "OU", "OL"]);

export type CommandOutcome =
  /** The process ran. `code` is its exit status; `stdout` may be empty. */
  | { kind: "ok"; code: number; stdout: string }
  /** The executable is not on PATH. Distinct from "ran and failed". */
  | { kind: "missing" };

export type CommandRunner = (cmd: string, args: readonly string[]) => Promise<CommandOutcome>;

export interface WindowsAclDeps {
  /** Injected for tests, so the whole module is exercisable on Linux. */
  run?: CommandRunner;
  /**
   * Where the `/save` scratch descriptor goes. Defaults to the OS temp
   * directory — never the settings directory and never a workspace folder
   * (hard rule 1): this file is ours, transient, and holds no user content.
   */
  scratchDir?: string;
}

/** What a DACL read produced. Three outcomes, because they mean three things. */
export type DaclRead =
  | { kind: "acl"; principals: readonly string[] }
  | { kind: "missing" }
  | { kind: "unverifiable"; reason: string };

/** The Windows arm of `PermissionRepair`; see `writer.ts` for the whole union. */
export type AclOutcome =
  | { kind: "aclOk" }
  | { kind: "aclRepaired"; before: readonly string[] }
  | { kind: "aclLoose"; found: readonly string[]; reason?: string }
  | { kind: "unverifiable"; reason: string }
  | { kind: "unsupported" };

/**
 * Read the DACL of `file`, tighten it if a broad principal can reach it, and
 * report what was found. The file is assumed to exist — `ensurePrivate` stats
 * it first, so "no file yet" is `absent` on every platform rather than an ACL
 * verdict here.
 */
export async function ensureWindowsAcl(
  file: string,
  deps: WindowsAclDeps = {},
): Promise<AclOutcome> {
  const run = deps.run ?? defaultRun;
  const scratchDir = deps.scratchDir ?? os.tmpdir();

  const before = await readDacl(file, run, scratchDir);
  if (before.kind === "missing") {
    return { kind: "unsupported" };
  }
  if (before.kind === "unverifiable") {
    return before;
  }
  const loose = before.principals.filter((sid) => BROAD_PRINCIPALS.includes(sid));
  if (loose.length === 0) {
    return { kind: "aclOk" };
  }

  // A repair grants *this* user, so we have to know which SID that is. Without
  // it the honest answer is "loose and not repaired" — granting a name here
  // would reintroduce exactly the localisation bug Q-AG closed.
  const sid = await currentUserSid(run);
  if (sid === undefined) {
    return { kind: "aclLoose", found: loose, reason: "could not determine the current user" };
  }

  // Secure this user's grant before removing inheritance, so a failed grant
  // cannot leave them locked out. Then remove inherited and explicit broad grants.
  const grant = await run("icacls", [file, "/grant", `*${sid}:F`, "/q"]);
  if (grant.kind === "missing" || grant.code !== 0)
    return {
      kind: "aclLoose",
      found: loose,
      reason: "Windows could not grant access to the current user; inheritance was left unchanged",
    };
  const inheritance = await run("icacls", [file, "/inheritance:r", "/q"]);
  if (inheritance.kind === "missing" || inheritance.code !== 0)
    return { kind: "aclLoose", found: loose, reason: "Windows could not disable inherited access" };
  // …and then the explicit form, for the case where somebody granted it
  // directly on the file, which `/inheritance:r` leaves untouched.
  const remove = await run("icacls", [
    file,
    "/remove:g",
    ...BROAD_PRINCIPALS.map((s) => `*${s}`),
    "/q",
  ]);
  if (remove.kind === "missing" || remove.code !== 0)
    return {
      kind: "aclLoose",
      found: loose,
      reason: "Windows could not remove broad access grants",
    };

  const after = await readDacl(file, run, scratchDir);
  if (after.kind === "missing") {
    return { kind: "unsupported" };
  }
  if (after.kind === "unverifiable") {
    return after;
  }
  const still = after.principals.filter((s) => BROAD_PRINCIPALS.includes(s));
  return still.length === 0
    ? { kind: "aclRepaired", before: loose }
    : { kind: "aclLoose", found: still };
}

/**
 * Every principal named in the file's DACL, as a SID.
 *
 * `/q` suppresses the success chatter and `/c` keeps `icacls` going past a
 * per-file error, so the scratch descriptor is written even in the partial
 * cases — and the summary line that survives is skipped by the parser rather
 * than matched against.
 */
async function readDacl(file: string, run: CommandRunner, scratchDir: string): Promise<DaclRead> {
  const scratch = path.join(scratchDir, `scd-acl-${randomUUID()}.txt`);
  try {
    const outcome = await run("icacls", [file, "/save", scratch, "/q", "/c"]);
    if (outcome.kind === "missing") {
      return { kind: "missing" };
    }
    if (outcome.code !== 0) {
      return {
        kind: "unverifiable",
        reason: `icacls could not export the permissions (exit ${outcome.code}). Ask IT to check access to the settings file and the temporary directory.`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(scratch);
    } catch {
      return {
        kind: "unverifiable",
        reason:
          "The icacls permissions export could not be read from the temporary directory. Ask IT to check temporary-file access.",
      };
    }

    if (bytes.length === 0)
      return {
        kind: "unverifiable",
        reason:
          "icacls produced an empty permissions export. Ask IT to check access to the settings file.",
      };
    const raw = decode(bytes);
    if (raw === undefined)
      return {
        kind: "unverifiable",
        reason: `The icacls permissions export has an unsupported or malformed encoding (${bytes.length} bytes). Copy diagnostics for support.`,
      };
    const dacl = parseDacl(raw);
    return dacl === undefined
      ? {
          kind: "unverifiable",
          reason: `No complete access control list could be read from the icacls export (${bytes.length} bytes). Copy diagnostics for support.`,
        }
      : { kind: "acl", principals: dacl };
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => {});
  }
}

/**
 * The SIDs granted access by the first DACL in an SDDL document, or `undefined`
 * when there is no DACL in it at all.
 *
 * Defensive by construction, because the input is whatever a Windows host
 * happened to write: the file names `icacls` interleaves with the descriptors,
 * blank lines, CRLF, a localised summary line that `/q` did not suppress, and
 * ACE types we have never seen all fall through without matching.
 */
export function parseDacl(raw: string): readonly string[] | undefined {
  const match = raw
    .split(/[\r\n]+/)
    .map((line) => DACL.exec(line.trim()))
    .find((hit) => hit !== null);
  if (match === undefined) {
    return undefined;
  }
  const flags = match[1] ?? "";
  // A NULL DACL is not "no information": it is *unrestricted access*, which is
  // the single worst state this file can be in. Reporting it as unparseable
  // would downgrade the loudest finding into a shrug.
  if (flags.includes("NO_ACCESS_CONTROL")) {
    return [EVERYONE];
  }

  const principals: string[] = [];
  for (const [, body] of (match[2] ?? "").matchAll(ACE)) {
    const fields = (body ?? "").split(";");
    const type = (fields[0] ?? "").trim().toUpperCase();
    const principal = (fields[5] ?? "").trim();
    if (fields.length !== 6 || !/^(?:S-1-(?:\d+-)*\d+|[A-Z]{2})$/.test(principal)) return undefined;
    if (NON_GRANT_ACE_TYPES.has(type)) {
      continue;
    }
    principals.push(normalizeSid(principal));
  }
  return principals;
}

/**
 * Match a complete descriptor line, not a D: drive path or a truncated ACE.
 * Conditional/nested ACEs are deliberately unverifiable rather than partially parsed.
 */
const DACL =
  /^(?:O:(?:S-1-[\d-]+|[A-Z]{2}))?(?:G:(?:S-1-[\d-]+|[A-Z]{2}))?D:((?:P|AI|AR|NO_ACCESS_CONTROL)*)((?:\([^()]*\))*)(?:S:[A-Z]*(?:\([^()]*\))*)?$/;
const ACE = /\(([^()]*)\)/g;

/** An SDDL principal is a literal SID or a two-letter alias; both end as a SID. */
function normalizeSid(principal: string): string {
  const upper = principal.toUpperCase();
  if (upper.startsWith("S-1-")) {
    return upper;
  }
  return SDDL_ALIASES[upper] ?? upper;
}

/**
 * Accept UTF-16 with or without a BOM and UTF-8. A BOM-less Unicode export
 * contains NULs in the ASCII D: marker; never strip NULs or decode lossily.
 */
function decode(bytes: Buffer): string | undefined {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes.indexOf(Buffer.from([0x44, 0, 0x3a, 0])) % 2 === 0) encoding = "utf-16le";
  else if (bytes.indexOf(Buffer.from([0, 0x44, 0, 0x3a])) % 2 === 0) encoding = "utf-16be";
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * The current user's SID, for the repair grant.
 *
 * `whoami /user /fo csv /nh` prints `"HOST\user","S-1-5-21-…"`. The name half is
 * localised on some hosts; the SID half is not, and the SID half is the only
 * part read.
 */
async function currentUserSid(run: CommandRunner): Promise<string | undefined> {
  const outcome = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
  if (outcome.kind === "missing" || outcome.code !== 0) {
    return undefined;
  }
  return /S-1-(?:\d+-)+\d+/.exec(outcome.stdout)?.[0];
}

/**
 * A non-zero exit is data, not an exception: `icacls` reports "no such file"
 * and "access denied" that way, and both are answers this module turns into a
 * verdict. Only a missing executable is special-cased, because it is the one
 * outcome that means the question cannot be asked at all.
 */
const defaultRun: CommandRunner = async (cmd, args) => {
  try {
    const { stdout } = await execFile(cmd, [...args], {
      timeout: ICACLS_TIMEOUT_MS,
      windowsHide: true,
    });
    return { kind: "ok", code: 0, stdout };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
    if (failure.code === "ENOENT") {
      return { kind: "missing" };
    }
    return {
      kind: "ok",
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    };
  }
};
