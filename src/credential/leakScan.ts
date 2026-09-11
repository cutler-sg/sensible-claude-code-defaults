/**
 * FR-4.8's workspace scan: is the Bedrock API key sitting in a project file?
 *
 * This is the check that earns its keep with this audience. A non-technical
 * user who has been told "put the key in a `.env`" by a tutorial, or who
 * pasted it into a scratch note, has a credential heading for a git remote —
 * and no way of knowing.
 *
 * Three rules shape everything below.
 *
 * **It never writes.** Hard rule 1 forbids writing inside a workspace folder,
 * and plan Q-AD closes the question: editing a user's repository file to strip
 * a secret is exactly the class of action that rule exists to prevent, and
 * rotation is the real remedy anyway. The scan finds; the user removes.
 *
 * **It is time-boxed, and says so.** A scan that runs out of budget reports
 * `partial`, never a clean bill of health. "We looked at some of your files and
 * found nothing" and "your key is not in your project" are different claims,
 * and only the first one is true after a timeout.
 *
 * **It checks trust itself (§13).** The extension declares
 * `untrustedWorkspaces.supported` because it operates on the user profile — but
 * this is the one component that reads workspace content, so it asks whether
 * the workspace is trusted rather than relying on a manifest declaration that
 * is about something else. Injected, so it stays testable.
 *
 * **It stays inside the folders it was given.** Each folder is resolved with
 * `realpath` and every path read is required to sit under that resolved root.
 * VS Code hands `uri.fsPath` through verbatim, so a folder can arrive as a
 * traversal or be a symlink to somewhere else entirely — and reading through
 * one means reading files the workspace-trust decision never covered, and
 * reporting a hit at a path that is not where the file is (F5).
 *
 * Nothing here imports `vscode`: the folders, the trust answer and the clock
 * all arrive as data.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** FR-4.8's budget. Beyond this the scan stops and reports what it managed. */
export const SCAN_BUDGET_MS = 3000;

/** A file bigger than this is not a config file or a note; it is a build artefact. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Enough to cover any real project; a cap so a symlinked monorepo cannot spin. */
export const MAX_FILES = 5000;

/**
 * Never descended into, at any depth. Each of these is generated or versioned
 * content whose *name* is unambiguous wherever it appears: nobody keeps notes
 * in a `node_modules`, and a monorepo has one per package, so skipping them
 * everywhere is what keeps the 3 s budget meaningful.
 *
 * A hit inside `.git` is history — a real problem, but not one this scan can
 * act on; `cred.leak` says so separately when a hit's file is tracked.
 */
export const SKIPPED_DIRS_ANYWHERE: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".venv",
]);

/**
 * Skipped only as an immediate child of a workspace folder (F10).
 *
 * `dist` and `out` are build directories at the top of a repository and
 * ordinary source directory names anywhere else — `src/out/`, `lib/dist/`,
 * `docs/dist/`. Matching them by basename at any depth meant a key pasted into
 * `src/out/notes.md` reported a clean bill of health, and a false clean is the
 * worst answer this scan can give: the user reads "your key is not in your
 * project" and stops looking.
 *
 * Root-only keeps what the rule was for — the build output, which is where the
 * volume is — and gives it up nowhere it was actually protecting anything.
 */
export const SKIPPED_DIRS_AT_ROOT: ReadonlySet<string> = new Set(["dist", "out"]);

/**
 * What is worth reading. Deliberately not "every file": the point is the places
 * a credential actually ends up — a settings file, an env file, a note, a
 * script, a container recipe — and reading a repository's entire source tree
 * for a string is a different, much slower product.
 *
 * `.txt`, `.yaml`, `.yml` and `.toml` are here because a key pasted "somewhere
 * to keep it" lands in a note or a config file far more often than in a shell
 * script, and `.bak` because a settings file copied before editing is
 * `settings.json.bak` and was invisible to an extension-only rule (F11).
 */
const EXTENSIONS: ReadonlySet<string> = new Set([
  ".json",
  ".md",
  ".sh",
  ".ps1",
  ".bat",
  ".cmd",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".bak",
]);

/**
 * Files with no extension, or whose extension is not the interesting part.
 *
 * A shell profile is where a user told to "export it" by a tutorial puts the
 * key permanently, and a `Dockerfile` is where one told to "put it in the
 * image" puts it — both are inside the project folder and both were unreadable
 * to an extension-based rule.
 */
const EXACT_NAMES: ReadonlySet<string> = new Set([
  ".envrc",
  ".zshrc",
  ".bashrc",
  ".bash_profile",
  ".zprofile",
  ".profile",
  "Dockerfile",
]);

export interface LeakHit {
  /** Absolute path. The **only** thing reported: never a line, never a snippet. */
  file: string;
  /** 1-based, for the "open the file" fix. Not rendered as text anywhere. */
  line: number;
  /**
   * Whether git is tracking this file, or undefined when nobody asked.
   *
   * It changes the advice completely: a tracked file has almost certainly had
   * the value committed at some point, and no edit to the working tree takes
   * it out of history. Rotation is then the only real remedy, and saying so is
   * the difference between a user who fixes the problem and one who deletes a
   * line and believes they have.
   */
  tracked?: boolean;
}

export type ScanOutcome =
  /** Every candidate file was read. `hits` is exhaustive. */
  | { kind: "clean" }
  | { kind: "hits"; hits: LeakHit[] }
  /**
   * The budget or a cap ran out first. `hits` is what was found before
   * stopping, and an empty `hits` here means "we did not finish", never "your
   * project is clean".
   */
  | { kind: "partial"; hits: LeakHit[]; reason: "timeout" | "file-cap" }
  /** No token to look for, no folders open, or the workspace is not trusted. */
  | { kind: "skipped"; reason: "no-token" | "no-folders" | "untrusted" };

export interface LeakScanDeps {
  /** The value to look for, or undefined when no key is set. */
  token: string | undefined;
  /** Open workspace folders, absolute. */
  folders: readonly string[];
  /** `vscode.workspace.isTrusted` (§13). Injected so the gate stays testable. */
  isTrusted: boolean;
  /**
   * Whether git tracks a path. Injected — running `git` is the host's job, and
   * a scan that shelled out itself could not be tested without a repository.
   * Optional: without it a hit simply does not know, and `cred.leak` gives the
   * advice that is true either way.
   */
  isTracked?: (file: string) => Promise<boolean | undefined>;
  now?: () => number;
  budgetMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
}

/**
 * FR-4.8. Never throws: a health check that fails because a directory changed
 * under it is worse than one that reports what it managed to see.
 */
export async function scanWorkspaceForToken(deps: LeakScanDeps): Promise<ScanOutcome> {
  const token = deps.token?.trim();
  // Short-circuited in this order on purpose: without a token there is nothing
  // to look for, so the trust question does not arise and neither does reading
  // a single byte of anyone's workspace.
  if (token === undefined || token === "") return { kind: "skipped", reason: "no-token" };
  if (!deps.isTrusted) return { kind: "skipped", reason: "untrusted" };
  if (deps.folders.length === 0) return { kind: "skipped", reason: "no-folders" };

  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (deps.budgetMs ?? SCAN_BUDGET_MS);
  const maxFiles = deps.maxFiles ?? MAX_FILES;
  const maxBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;

  const hits: LeakHit[] = [];
  let examined = 0;
  /**
   * Files already read. Paths are already resolved-and-contained by the time
   * they land here, so this is what stops two open folders that overlap — or
   * one nested inside another — reading the same file twice and reporting it
   * as two hits.
   */
  const seen = new Set<string>();

  /**
   * `root` is the resolved workspace folder and never changes down the
   * recursion; `dir` is where we are. `root` is what `SKIPPED_DIRS_AT_ROOT` is
   * measured against — containment itself needs no check, and a check would be
   * worse than none: `path.join(dir, entry.name)` over a `readdir` result
   * cannot produce a path outside `dir` (there is no `..` in a directory
   * listing), and the walk only ever descends into real directories, because
   * `isDirectory()` is false for a symlink to one. Resolving the root with
   * `realpath` before the walk starts is therefore the whole of F5: it is what
   * makes "inside the folder the user opened" and "inside the folder the
   * trust decision covered" the same directory.
   */
  const visit = async (dir: string, root: string): Promise<"ok" | "timeout" | "file-cap"> => {
    if (now() >= deadline) return "timeout";

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot list is not a failure of the scan: permissions
      // vary, and a mount can disappear. Skip it and keep going.
      return "ok";
    }

    for (const entry of entries) {
      if (now() >= deadline) return "timeout";
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRS_ANYWHERE.has(entry.name)) continue;
        // Root-only (F10): `dist` and `out` are build output at the top of a
        // repository and ordinary source folders anywhere else.
        if (dir === root && SKIPPED_DIRS_AT_ROOT.has(entry.name)) continue;
        const outcome = await visit(full, root);
        if (outcome !== "ok") return outcome;
        continue;
      }
      // Symlinks are not followed. A link out of the workspace would take the
      // scan somewhere the user did not open, and a link cycle would take it
      // nowhere at all.
      if (!entry.isFile()) continue;
      if (!isCandidate(entry.name)) continue;
      if (examined >= maxFiles) return "file-cap";

      if (seen.has(full)) continue;
      seen.add(full);
      examined += 1;

      const line = await findToken(full, token, maxBytes);
      if (line !== undefined) hits.push({ file: full, line });

      // F8. Checked here, not only at the top of the next entry: `stat` +
      // `readFile` + the newline count is the expensive part, and the last
      // candidate file in a walk has no next entry to be checked against — so
      // a read that ran past the deadline used to fall out of the loop, out of
      // `visit` as `ok`, and out of the scan as **clean**. FR-4.8's three
      // seconds is a guarantee, and a false all-clear is the one answer this
      // module must never give.
      if (now() >= deadline) return "timeout";
    }
    return "ok";
  };

  for (const folder of deps.folders) {
    // Resolved before anything is read, so the walk's containment check and
    // the paths it reports both describe where the files actually are. A
    // folder that does not resolve is skipped whole rather than walked
    // unresolved: without a root there is nothing to hold the walk inside.
    const root = await fsp.realpath(folder).catch(() => undefined);
    if (root === undefined) continue;

    const outcome = await visit(root, root);
    if (outcome !== "ok") {
      // A partial result is still asked about tracking: the hits it did find
      // are real, and the advice they need does not depend on the scan having
      // finished.
      return { kind: "partial", hits: await withTracking(hits, deps.isTracked), reason: outcome };
    }
  }

  if (hits.length === 0) return { kind: "clean" };
  return { kind: "hits", hits: await withTracking(hits, deps.isTracked) };
}

/**
 * Asked once per hit, after the walk rather than during it. A `git` invocation
 * inside the walk would be inside the time budget, which is meant for reading
 * files — and there are at most a handful of hits.
 */
async function withTracking(
  hits: readonly LeakHit[],
  isTracked: LeakScanDeps["isTracked"],
): Promise<LeakHit[]> {
  if (isTracked === undefined) return [...hits];
  return Promise.all(
    hits.map(async (hit) => {
      // A `git` that is absent, or a folder that is not a repository, answers
      // undefined rather than throwing the scan away.
      const tracked = await isTracked(hit.file).catch(() => undefined);
      return tracked === undefined ? hit : { ...hit, tracked };
    }),
  );
}

/**
 * FR-4.8's file list: `.claude/settings*.json`, `.env*`, the extensions a
 * credential is realistically pasted into, and a handful of exact names whose
 * extension is not the interesting part (F11).
 *
 * `.env*` is matched by prefix rather than by extension — `.env.local`,
 * `.env.production` and bare `.env` are all the same file to a user, and the
 * extension-based rule would see `.local` and skip. `Dockerfile` gets the same
 * treatment for `Dockerfile.dev` and friends.
 */
function isCandidate(name: string): boolean {
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return true;
  if (EXACT_NAMES.has(name)) return true;
  return EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * The 1-based line the token appears on, or undefined.
 *
 * The size cap is checked by `stat` before the read, not after: reading a
 * gigabyte in order to decide it was too big is the failure mode the cap
 * exists to prevent. A file that is not valid UTF-8 simply will not contain the
 * token as a string, so no encoding detection is needed.
 */
async function findToken(
  file: string,
  token: string,
  maxBytes: number,
): Promise<number | undefined> {
  let content: string;
  try {
    const stats = await fsp.stat(file);
    if (stats.size > maxBytes) return undefined;
    content = await fsp.readFile(file, "utf8");
  } catch {
    return undefined;
  }

  const at = content.indexOf(token);
  if (at === -1) return undefined;
  // Counted rather than split: splitting a 1 MiB file to find one line number
  // allocates the whole thing again for a number nobody reads as text.
  let line = 1;
  for (let i = 0; i < at; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}
