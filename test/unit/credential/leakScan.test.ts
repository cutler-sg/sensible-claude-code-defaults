import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  SCAN_BUDGET_MS,
  SKIPPED_DIRS,
  scanWorkspaceForToken,
} from "../../../src/credential/leakScan.js";

const TOKEN = "ABSKTGVha1NjYW5UZXN0QmVkcm9ja0tleVZhbHVl";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-leak-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(relative: string, content: string): Promise<string> {
  const full = join(dir, relative);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
  return full;
}

function scan(overrides: Partial<Parameters<typeof scanWorkspaceForToken>[0]> = {}) {
  return scanWorkspaceForToken({ token: TOKEN, folders: [dir], isTrusted: true, ...overrides });
}

describe("what the scan refuses to do", () => {
  it("does nothing when no key is set", async () => {
    await file(".env", `AWS_BEARER_TOKEN_BEDROCK=${TOKEN}`);

    await expect(scan({ token: undefined })).resolves.toEqual({
      kind: "skipped",
      reason: "no-token",
    });
  });

  it("treats an empty or whitespace token as no key", async () => {
    await expect(scan({ token: "   " })).resolves.toEqual({ kind: "skipped", reason: "no-token" });
  });

  /**
   * §13. The extension declares `untrustedWorkspaces.supported` because it
   * operates on the user profile — this is the one component that reads
   * workspace content, so it asks the trust question itself rather than
   * relying on a manifest declaration about something else.
   */
  it("reads nothing at all in an untrusted workspace", async () => {
    await file(".env", `AWS_BEARER_TOKEN_BEDROCK=${TOKEN}`);

    await expect(scan({ isTrusted: false })).resolves.toEqual({
      kind: "skipped",
      reason: "untrusted",
    });
  });

  it("does nothing with no folders open", async () => {
    await expect(scan({ folders: [] })).resolves.toEqual({
      kind: "skipped",
      reason: "no-folders",
    });
  });

  /**
   * The trust gate is asked before a single byte is read, so an untrusted
   * workspace cannot even be enumerated. Checked structurally: the scan is
   * pointed at a path that does not exist, and a `skipped` answer proves it
   * never tried to walk it.
   */
  it("asks about trust before touching the filesystem", async () => {
    const outcome = await scanWorkspaceForToken({
      token: TOKEN,
      folders: [join(dir, "does-not-exist")],
      isTrusted: false,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "untrusted" });
  });
});

describe("what the scan finds", () => {
  it("finds the key in a project .env", async () => {
    const path = await file(".env", `PORT=3000\nAWS_BEARER_TOKEN_BEDROCK=${TOKEN}\n`);

    const outcome = await scan();

    expect(outcome).toEqual({ kind: "hits", hits: [{ file: path, line: 2 }] });
  });

  it("finds the key in a project .claude/settings.json", async () => {
    const path = await file(
      ".claude/settings.json",
      `${JSON.stringify({ env: { AWS_BEARER_TOKEN_BEDROCK: TOKEN } }, null, 2)}\n`,
    );

    const outcome = await scan();

    expect(outcome).toMatchObject({ kind: "hits" });
    expect(outcome.kind === "hits" && outcome.hits[0]?.file).toBe(path);
  });

  it("finds the key in a .env with a suffix", async () => {
    await file(".env.production", TOKEN);

    await expect(scan()).resolves.toMatchObject({ kind: "hits" });
  });

  it.each([".md", ".sh", ".ps1", ".json"])("reads a %s file", async (extension) => {
    await file(`notes${extension}`, `my key is ${TOKEN}`);

    await expect(scan()).resolves.toMatchObject({ kind: "hits" });
  });

  it("reports clean when the key is nowhere", async () => {
    await file(".env", "PORT=3000");
    await file("README.md", "nothing to see");

    await expect(scan()).resolves.toEqual({ kind: "clean" });
  });

  it("finds every occurrence across folders, not just the first", async () => {
    const one = await file("a/.env", TOKEN);
    const two = await file("b/notes.md", TOKEN);

    const outcome = await scan();

    expect(outcome.kind).toBe("hits");
    const files = outcome.kind === "hits" ? outcome.hits.map((hit) => hit.file).sort() : [];
    expect(files).toEqual([one, two].sort());
  });

  it("scans every open folder", async () => {
    const other = await mkdtemp(join(tmpdir(), "scd-leak-2-"));
    try {
      await writeFile(join(other, ".env"), TOKEN, "utf8");

      const outcome = await scan({ folders: [dir, other] });

      expect(outcome).toMatchObject({ kind: "hits" });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("counts the line from the start of the file", async () => {
    await file("notes.md", `one\ntwo\nthree\n${TOKEN}`);

    const outcome = await scan();

    expect(outcome.kind === "hits" && outcome.hits[0]?.line).toBe(4);
  });

  it("reports a path and a line and nothing else — never a snippet", async () => {
    await file(".env", `SECRET_CONTEXT_AROUND=${TOKEN} trailing words`);

    const outcome = await scan();

    expect(outcome.kind).toBe("hits");
    const hit = outcome.kind === "hits" ? outcome.hits[0] : undefined;
    expect(Object.keys(hit ?? {}).sort()).toEqual(["file", "line"]);
    expect(JSON.stringify(hit)).not.toContain(TOKEN);
    expect(JSON.stringify(hit)).not.toContain("trailing words");
  });
});

describe("what the scan skips", () => {
  it.each([...SKIPPED_DIRS])("never descends into %s", async (skipped) => {
    await file(`${skipped}/leaked.json`, TOKEN);

    await expect(scan()).resolves.toEqual({ kind: "clean" });
  });

  it("ignores a file type a credential does not end up in", async () => {
    await file("bundle.js", TOKEN);
    await file("image.png", TOKEN);

    await expect(scan()).resolves.toEqual({ kind: "clean" });
  });

  it("ignores a file over the size cap", async () => {
    await file("big.json", `${"x".repeat(200)}${TOKEN}`);

    await expect(scan({ maxFileBytes: 100 })).resolves.toEqual({ kind: "clean" });
  });

  it("reads a file exactly at the size cap", async () => {
    const content = `${TOKEN}`;
    await file("small.json", content);

    await expect(scan({ maxFileBytes: Buffer.byteLength(content, "utf8") })).resolves.toMatchObject(
      { kind: "hits" },
    );
  });

  /**
   * A link out of the workspace would take the scan somewhere the user did not
   * open, and a link cycle would take it nowhere at all.
   */
  it("does not follow symlinks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "scd-leak-out-"));
    try {
      await writeFile(join(outside, "leaked.json"), TOKEN, "utf8");
      await symlink(outside, join(dir, "linked"), "dir");
      await symlink(join(outside, "leaked.json"), join(dir, "linked.json"), "file");

      await expect(scan()).resolves.toEqual({ kind: "clean" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps going past a folder it cannot list", async () => {
    await file(".env", TOKEN);
    // A folder that is really a file: `readdir` throws ENOTDIR. Permissions
    // vary and mounts disappear, so an unlistable directory is skipped rather
    // than ending the scan.
    const notADirectory = await file("notadir.json", "nothing");

    await expect(scan({ folders: [notADirectory, dir] })).resolves.toMatchObject({
      kind: "hits",
    });
  });

  it("keeps going past a file it cannot read", async () => {
    await file(".env", TOKEN);
    const unreadable = await file("locked.json", TOKEN);
    await chmod(unreadable, 0o000);

    try {
      const outcome = await scan();

      // The unreadable file is skipped, not fatal — and the readable hit still
      // comes back. (Running as root would defeat the chmod, so the assertion
      // is on the scan surviving rather than on the file being missed.)
      expect(outcome).toMatchObject({ kind: "hits" });
    } finally {
      await chmod(unreadable, 0o600);
    }
  });
});

/**
 * The rule that matters most: a scan that ran out of budget must never be
 * mistaken for a clean bill of health. "We looked at some of your files and
 * found nothing" and "your key is not in your project" are different claims.
 */
describe("running out of budget", () => {
  it("reports partial rather than clean when the clock runs out", async () => {
    await file("a.json", "nothing");
    await file("b.json", "nothing");
    let ticks = 0;
    // Time only advances when asked, so the deadline is crossed deterministically
    // rather than by hoping a real scan is slow.
    const now = (): number => {
      ticks += 1;
      return ticks > 2 ? 10_000 : 0;
    };

    const outcome = await scan({ now, budgetMs: 100 });

    expect(outcome).toMatchObject({ kind: "partial", reason: "timeout" });
  });

  it("carries the hits it did find into a partial result", async () => {
    await file(".env", TOKEN);
    // Enough files that the walk cannot finish within one tick.
    for (let i = 0; i < 20; i += 1) await file(`filler-${i}.json`, "nothing");
    let ticks = 0;
    const now = (): number => {
      ticks += 1;
      return ticks > 6 ? 10_000 : 0;
    };

    const outcome = await scan({ now, budgetMs: 100 });

    // Either it finished within the ticks or it stopped — both are valid, but a
    // stop must be reported as partial, never as clean.
    expect(outcome.kind === "partial" || outcome.kind === "hits").toBe(true);
    expect(outcome.kind).not.toBe("clean");
  });

  it("stops at the file cap and reports partial", async () => {
    for (let i = 0; i < 6; i += 1) await file(`f-${i}.json`, "nothing");

    const outcome = await scan({ maxFiles: 3 });

    expect(outcome).toMatchObject({ kind: "partial", reason: "file-cap" });
  });

  it("reports the hits found before the file cap was reached", async () => {
    await file("a.json", TOKEN);
    for (let i = 0; i < 6; i += 1) await file(`z-${i}.json`, "nothing");

    const outcome = await scan({ maxFiles: 3 });

    expect(outcome).toMatchObject({ kind: "partial", reason: "file-cap" });
    expect(outcome.kind === "partial" && outcome.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("checks the clock before reading the first directory", async () => {
    await file(".env", TOKEN);

    const outcome = await scan({ now: () => 10_000, budgetMs: 0 });

    expect(outcome).toEqual({ kind: "partial", hits: [], reason: "timeout" });
  });
});

describe("the caps themselves", () => {
  it("are the values FR-4.8 asks for", () => {
    expect(SCAN_BUDGET_MS).toBe(3000);
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
    expect(MAX_FILES).toBe(5000);
  });

  it("apply by default, without a caller opting in", async () => {
    await file(".env", TOKEN);

    // No `budgetMs`, `maxFiles` or `maxFileBytes`: the defaults are what a
    // real host gets, and a scan of a two-file directory finishes inside them.
    await expect(
      scanWorkspaceForToken({ token: TOKEN, folders: [dir], isTrusted: true }),
    ).resolves.toMatchObject({ kind: "hits" });
  });
});

/**
 * Whether git tracks a hit changes the advice completely: no edit to a working
 * tree takes a value out of history, so a tracked file means rotation is the
 * only real remedy. The question is injected — running `git` is the host's job.
 */
describe("asking git about a hit", () => {
  it("marks a hit git tracks", async () => {
    await file(".env", TOKEN);

    const outcome = await scan({ isTracked: async () => true });

    expect(outcome.kind === "hits" && outcome.hits[0]?.tracked).toBe(true);
  });

  it("marks a hit git does not track", async () => {
    await file(".env", TOKEN);

    const outcome = await scan({ isTracked: async () => false });

    expect(outcome.kind === "hits" && outcome.hits[0]?.tracked).toBe(false);
  });

  it("leaves tracking unknown when nobody asked", async () => {
    await file(".env", TOKEN);

    const outcome = await scan();

    expect(outcome.kind === "hits" && "tracked" in (outcome.hits[0] ?? {})).toBe(false);
  });

  it("leaves tracking unknown when git cannot answer", async () => {
    await file(".env", TOKEN);

    const outcome = await scan({ isTracked: async () => undefined });

    // Undefined is "we do not know", which must not become a `false` claim.
    expect(outcome.kind === "hits" && "tracked" in (outcome.hits[0] ?? {})).toBe(false);
  });

  it("survives a git query that throws", async () => {
    await file(".env", TOKEN);

    const outcome = await scan({
      isTracked: () => Promise.reject(new Error("git: command not found")),
    });

    expect(outcome).toMatchObject({ kind: "hits" });
    expect(outcome.kind === "hits" && "tracked" in (outcome.hits[0] ?? {})).toBe(false);
  });

  it("asks about the hits a partial scan did find", async () => {
    await file("a.json", TOKEN);
    for (let i = 0; i < 6; i += 1) await file(`z-${i}.json`, "nothing");

    const outcome = await scan({ maxFiles: 3, isTracked: async () => true });

    expect(outcome.kind).toBe("partial");
    expect(outcome.kind === "partial" && outcome.hits.some((hit) => hit.tracked === true)).toBe(
      true,
    );
  });
});
