import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  SCAN_BUDGET_MS,
  SKIPPED_DIRS_ANYWHERE,
  SKIPPED_DIRS_AT_ROOT,
  scanWorkspaceForToken,
} from "../../../src/credential/leakScan.js";

/**
 * Every `node:fs/promises` function the scan reaches for, in call order.
 *
 * Two assertions in this file are about what the scan *touches* rather than
 * what it returns, and neither can be made from an outcome: "the trust gate is
 * asked before a byte is read" and "nothing is ever written inside a workspace
 * folder" (hard rule 1) are both invisible to a caller that only sees a
 * `ScanOutcome`. So the module is wrapped and the calls are recorded.
 *
 * The wrapper passes straight through, so every other test in this file — and
 * this file's own `mkdtemp`/`writeFile` fixtures — behave exactly as before.
 * Tests that care reset the log immediately before the call under test.
 */
const fsCalls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            fsCalls.push(name);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
});

/**
 * The only filesystem calls a scan is allowed to make. An allowlist rather than
 * a list of forbidden writes: a call this list does not name has to be argued
 * for, which is the right default for the one component that reads a user's
 * project.
 */
const READ_ONLY_FS_CALLS = ["realpath", "readdir", "lstat", "stat", "readFile"];

const TOKEN = "ABSKTGVha1NjYW5UZXN0QmVkcm9ja0tleVZhbHVl";

let dir: string;

beforeEach(async () => {
  dir = await tempDir("scd-leak-");
});

/**
 * A temp directory at its *resolved* path. On macOS `os.tmpdir()` is `/var/...`,
 * a symlink to `/private/var/...`, and the scan resolves each root before it
 * walks — so a fixture holding the unresolved path disagrees with every hit the
 * scan reports, on that platform only. Resolving here keeps the assertions
 * about what the scan found rather than about how the temp path was spelled.
 */
async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

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
   * workspace cannot even be enumerated.
   *
   * The outcome alone cannot prove that. An earlier version of this test
   * pointed the scan at a path that does not exist and asserted `skipped` —
   * but `visit` swallows the `readdir` failure and answers `ok`, so `skipped`
   * came back whether the gate ran before the walk or after it, and moving the
   * gate to the end of the function left the whole suite green.
   *
   * So this one points at a directory that genuinely contains the token, and
   * asserts both halves: the answer is `skipped`, and the filesystem was never
   * touched at all.
   */
  it("asks about trust before touching the filesystem", async () => {
    await file(".env", `AWS_BEARER_TOKEN_BEDROCK=${TOKEN}`);
    fsCalls.length = 0;

    const outcome = await scan({ isTrusted: false });

    expect(outcome).toEqual({ kind: "skipped", reason: "untrusted" });
    expect(fsCalls).toEqual([]);
  });

  /** Same reasoning, for the gate that runs before it. */
  it("looks for nothing on the filesystem when there is no key", async () => {
    await file(".env", `AWS_BEARER_TOKEN_BEDROCK=${TOKEN}`);
    fsCalls.length = 0;

    const outcome = await scan({ token: undefined });

    expect(outcome).toEqual({ kind: "skipped", reason: "no-token" });
    expect(fsCalls).toEqual([]);
  });

  /**
   * Hard rule 1, and plan Q-AD. The extension never writes inside a workspace
   * folder, and the scan is the only component that is even in one — so the
   * rule is asserted here mechanically rather than left to review. A scan that
   * finds a hit is the case that would most tempt a fix-it-for-you write.
   */
  it("never writes anything inside a workspace folder (hard rule 1)", async () => {
    await file(".env", `AWS_BEARER_TOKEN_BEDROCK=${TOKEN}`);
    await file("notes.md", TOKEN);
    fsCalls.length = 0;

    await expect(scan({ isTracked: async () => true })).resolves.toMatchObject({ kind: "hits" });

    expect(fsCalls.filter((name) => !READ_ONLY_FS_CALLS.includes(name))).toEqual([]);
    // And the log is not vacuously empty: it really did read the files.
    expect(fsCalls).toContain("readFile");
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

  /**
   * F11. The names a credential realistically lands in, as a table rather than
   * as a sentence in a comment — the README makes a promise about this list and
   * a promise nothing checks is how the list drifts.
   */
  it.each([
    ".env.local",
    "settings.json.bak",
    ".envrc",
    "Dockerfile",
    "Dockerfile.dev",
    "config.yaml",
    "config.yml",
    "notes.txt",
    "config.toml",
    ".zshrc",
    ".bashrc",
    ".bash_profile",
    ".zprofile",
    ".profile",
    "run.bat",
    "run.cmd",
    ".claude.json",
  ])("reads %s", async (name) => {
    await file(name, `export AWS_BEARER_TOKEN_BEDROCK=${TOKEN}`);

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
    const other = await tempDir("scd-leak-2-");
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
  it.each([...SKIPPED_DIRS_ANYWHERE])("never descends into %s at the root", async (skipped) => {
    await file(`${skipped}/leaked.json`, TOKEN);

    await expect(scan()).resolves.toEqual({ kind: "clean" });
  });

  /**
   * These three are never a place a person pastes a key, and they are the ones
   * that make a repository expensive to walk — a monorepo has a `node_modules`
   * per package. Skipping them at every depth is what keeps the 3 s budget
   * meaningful.
   */
  it.each([...SKIPPED_DIRS_ANYWHERE])("never descends into a nested %s", async (skipped) => {
    await file(`packages/thing/${skipped}/leaked.json`, TOKEN);

    await expect(scan()).resolves.toEqual({ kind: "clean" });
  });

  it.each([...SKIPPED_DIRS_AT_ROOT])("skips %s at the workspace root", async (skipped) => {
    await file(`${skipped}/leaked.json`, TOKEN);

    await expect(scan()).resolves.toEqual({ kind: "clean" });
  });

  /**
   * F10. `out` and `dist` are build directories at the top of a repository and
   * ordinary source directory names anywhere else — `src/out/`, `lib/dist/`.
   * Matching them by basename at any depth meant a key in `src/out/notes.md`
   * reported a clean bill of health, which is the worst answer this scan can
   * give.
   */
  it.each([...SKIPPED_DIRS_AT_ROOT])(
    "reads a file inside a nested %s, which is an ordinary source folder",
    async (skipped) => {
      const path = await file(`src/${skipped}/notes.md`, TOKEN);

      const outcome = await scan();

      expect(outcome).toMatchObject({ kind: "hits" });
      expect(outcome.kind === "hits" && outcome.hits[0]?.file).toBe(path);
    },
  );

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
   * F5. `deps.folders` went to the walk verbatim: no `realpath`, no containment
   * check. The `!entry.isFile()` guard only stops links found *during* the
   * walk — the root itself was never resolved and never checked.
   *
   * The invariant these pin is one sentence: **every path the scan reads, and
   * every path it reports, sits under the resolved root of the folder that
   * produced it.** Not "a symlinked root is refused" — VS Code hands
   * `uri.fsPath` through verbatim and a symlinked project root
   * (`~/work` → `/mnt/shared/work`) is an ordinary way to work, so refusing it
   * would silently switch the check off for those users. Resolving it is what
   * makes the trust decision and the reported path describe the same directory.
   */
  describe("staying inside the folders the user opened (F5)", () => {
    it("reports a hit under a symlinked root at its real path, not through the link", async () => {
      const target = await tempDir("scd-leak-target-");
      try {
        await writeFile(join(target, ".env"), TOKEN, "utf8");
        const link = join(dir, "linked-root");
        await symlink(target, link, "dir");

        const outcome = await scan({ folders: [link] });

        // The hit is real and must be found — but named where the file
        // actually is. `<workspace>/linked-root/.env` reads as a path inside
        // the folder the user opened, and it is not one.
        expect(outcome).toMatchObject({ kind: "hits" });
        const found = outcome.kind === "hits" ? outcome.hits[0]?.file : undefined;
        expect(found).toBe(join(await realpath(target), ".env"));
        expect(found).not.toContain("linked-root");
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });

    it("normalises a folder path containing .. before reading anything", async () => {
      const outside = await tempDir("scd-leak-esc-");
      try {
        await writeFile(join(outside, ".env"), TOKEN, "utf8");
        await mkdir(join(dir, "sub"), { recursive: true });
        // `<workspace>/sub/../../<outside>`: a real directory, spelled as a
        // traversal. Reported unresolved, the hit path contains the workspace
        // folder's own name and reads as a file inside it.
        const traversal = join(dir, "sub", "..", "..", outside.split("/").pop() ?? "");

        const outcome = await scan({ folders: [traversal] });

        expect(outcome).toMatchObject({ kind: "hits" });
        const found = outcome.kind === "hits" ? outcome.hits[0]?.file : undefined;
        expect(found).toBe(join(await realpath(outside), ".env"));
        expect(found).not.toContain("..");
        expect(found).not.toContain(dir.split("/").pop() ?? "");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("reads nothing at all through a folder that does not resolve", async () => {
      fsCalls.length = 0;

      const outcome = await scan({ folders: [join(dir, "does-not-exist")] });

      // An unresolvable root is skipped whole: without a resolved root there is
      // nothing to hold the walk inside, so nothing is walked.
      expect(outcome).toEqual({ kind: "clean" });
      expect(fsCalls.filter((name) => name === "readdir")).toEqual([]);
    });

    it("keeps scanning the other folders when one does not resolve", async () => {
      await file(".env", TOKEN);

      await expect(scan({ folders: [join(dir, "does-not-exist"), dir] })).resolves.toMatchObject({
        kind: "hits",
      });
    });

    it("reports every hit under the resolved root, never a path outside it", async () => {
      const root = await realpath(dir);
      await file(".env", TOKEN);
      await file("deep/nested/notes.md", TOKEN);

      const outcome = await scan();

      expect(outcome.kind).toBe("hits");
      const files = outcome.kind === "hits" ? outcome.hits.map((hit) => hit.file) : [];
      expect(files).toHaveLength(2);
      for (const found of files) expect(found.startsWith(`${root}/`)).toBe(true);
    });

    /**
     * The containment check is a second line, behind the `!entry.isFile()`
     * guard: a directory swapped for a symlink between `readdir` and the
     * recursive descent would otherwise take the walk straight out of the
     * resolved root.
     */
    it("never reads a file outside the resolved root, even under a linked subdirectory", async () => {
      const outside = await tempDir("scd-leak-sub-");
      try {
        await writeFile(join(outside, "leaked.json"), TOKEN, "utf8");
        await symlink(outside, join(dir, "nested"), "dir");
        const escaped = join(await realpath(outside), "leaked.json");
        fsCalls.length = 0;

        const outcome = await scan();

        expect(outcome).toEqual({ kind: "clean" });
        expect(JSON.stringify(outcome)).not.toContain(escaped);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  /**
   * A link out of the workspace would take the scan somewhere the user did not
   * open, and a link cycle would take it nowhere at all.
   */
  it("does not follow symlinks", async () => {
    const outside = await tempDir("scd-leak-out-");
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

  /**
   * F8. The clock was checked at the top of each directory and at the top of
   * each entry, but never after the `stat` + `readFile` + newline count — and
   * the last candidate file in the walk has no entry after it to be checked
   * against. So a read that ran clean past the deadline fell out of the loop,
   * out of `visit` as `ok`, and out of the scan as **clean**: a false all-clear,
   * which is the one answer this module's header says it must never give.
   *
   * Time advances only when the scan asks, so the deadline is crossed
   * deterministically: frozen until the first file has actually been read, then
   * past the budget.
   */
  it("reports partial, not clean, when the last file read used up the budget", async () => {
    await file("only.json", "nothing");
    fsCalls.length = 0;
    const now = (): number => (fsCalls.includes("readFile") ? 10_000 : 0);

    const outcome = await scan({ now, budgetMs: 100 });

    expect(outcome).not.toEqual({ kind: "clean" });
    expect(outcome).toMatchObject({ kind: "partial", reason: "timeout" });
  });

  it("says the same when the last file is deep in a subdirectory", async () => {
    await file("a/b/c/only.json", "nothing");
    fsCalls.length = 0;
    const now = (): number => (fsCalls.includes("readFile") ? 10_000 : 0);

    const outcome = await scan({ now, budgetMs: 100 });

    expect(outcome).toMatchObject({ kind: "partial", reason: "timeout" });
  });

  /**
   * And the same when there is something to report: hits found before the
   * budget ran out are real, but the list is not exhaustive and must not be
   * presented as if it were.
   */
  it("reports partial rather than hits when the budget went during the last read", async () => {
    await file("only.json", TOKEN);
    fsCalls.length = 0;
    const now = (): number => (fsCalls.includes("readFile") ? 10_000 : 0);

    const outcome = await scan({ now, budgetMs: 100 });

    expect(outcome).toMatchObject({ kind: "partial", reason: "timeout" });
    expect(outcome.kind === "partial" && outcome.hits).toHaveLength(1);
  });

  /** The overshoot is bounded at one file: the read in flight, and no more. */
  it("reads no further file once a read has taken it past the deadline", async () => {
    for (let i = 0; i < 10; i += 1) await file(`f-${i}.json`, "nothing");
    fsCalls.length = 0;
    const now = (): number => (fsCalls.includes("readFile") ? 10_000 : 0);

    const outcome = await scan({ now, budgetMs: 100 });

    expect(outcome).toMatchObject({ kind: "partial", reason: "timeout" });
    expect(fsCalls.filter((name) => name === "readFile")).toHaveLength(1);
  });

  it("checks the clock before reading the first directory", async () => {
    await file(".env", TOKEN);

    const outcome = await scan({ now: () => 10_000, budgetMs: 0 });

    expect(outcome).toEqual({ kind: "partial", hits: [], reason: "timeout" });
  });
});

/**
 * The README makes promises about this scan in a section a user reads *instead
 * of* running it — "it skips `node_modules`, `.git`, `dist`, `out` and `.venv`"
 * was one of them, and it was wrong in a way that mattered: `dist` and `out`
 * were skipped at every depth, so a key in `src/out/notes.md` reported clean
 * while the README implied only build output was passed over (F10).
 *
 * A promise nothing checks is how that happens. These read the shipped file.
 */
describe("what the README promises", () => {
  // Relative to the repo root, which is vitest's cwd — `import.meta` is not
  // available in this project's CommonJS-targeted compile.
  const readme = readFileSync("README.md", "utf8");
  const section = readme.slice(readme.indexOf("### The project scan finds"));

  it("has a section about the scan to check", () => {
    expect(section).not.toBe("");
    expect(section.length).toBeGreaterThan(500);
  });

  it.each([...SKIPPED_DIRS_ANYWHERE])("names %s as skipped wherever it appears", (skipped) => {
    expect(section).toContain(`\`${skipped}\``);
  });

  it.each([...SKIPPED_DIRS_AT_ROOT])("says %s is skipped only at the top", (skipped) => {
    expect(section).toContain(`\`${skipped}\``);
    // The distinction is the whole point of F10: naming the folder without
    // saying "only at the top" is the sentence that was wrong before.
    expect(section).toMatch(/only when they sit\s+directly\s+inside a folder you have open/);
  });

  /**
   * Every extension the scan reads is named. The reverse direction matters
   * more than it looks: a README that lists a type the scan does not read is a
   * user who believes a file was checked when it was not.
   */
  it.each([
    ".env",
    ".envrc",
    ".json",
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".toml",
    ".sh",
    ".ps1",
    ".bat",
    ".cmd",
    ".bak",
    "Dockerfile",
    ".zshrc",
    ".bashrc",
    ".bash_profile",
    ".zprofile",
    ".profile",
  ])("names %s among the files it looks at", (name) => {
    expect(section).toContain(`\`${name}\``);
  });

  it("still states the three-second budget and the 1 MB cap", () => {
    expect(section).toContain("three seconds");
    expect(section).toContain("1 MB");
  });

  /** F7: the README must describe the found-and-incomplete case too. */
  it("says a scan can both find something and run out of time", () => {
    expect(section).toMatch(/finds a copy of\s+your key \*and\* runs out of time/);
  });

  /** F5, in the words a user reads. */
  it("says the scan stays inside the folders the user opened", () => {
    expect(section).toContain("stays inside the folders you opened");
    expect(section).toMatch(/shortcut to\s+somewhere else/);
  });

  /** Hard rule 1, stated to the user and asserted here. */
  it("still promises it never edits a project file", () => {
    expect(section).toContain("It never edits your files");
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
