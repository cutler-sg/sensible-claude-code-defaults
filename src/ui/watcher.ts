/**
 * Watch `settings.json` for changes made outside the extension (plan Q-Q).
 *
 * Watches the *parent directory*, not the file: Claude Code and this extension
 * both write settings atomically (write temp, rename over), which replaces the
 * inode. A watch on the file itself follows the old inode and goes deaf after
 * the first such write. `vscode.workspace.createFileSystemWatcher` is not an
 * option either — it is workspace-scoped, and `~/.claude` is not in the
 * workspace.
 *
 * On a fresh install `~/.claude` does not exist yet, so there is nothing to
 * watch. That is the *most* important moment to be watching — it is the one the
 * user is about to change — so the watch falls back a level and waits for the
 * directory itself to appear, then arms on the real thing.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";

export interface Disposable {
  dispose(): void;
}

export interface SettingsWatcher extends Disposable {
  /**
   * Try to arm on `~/.claude` now. A no-op when already armed. The commit path
   * calls this after a write that may have created the directory: we know it
   * exists at that instant, whereas the parent watch has to be told, and a
   * mkdir followed immediately by a write can coalesce into events we have
   * already read past.
   */
  rearm(): void;
}

/** The subset of `fs.watch` this needs, so tests can inject a fake. */
export type WatchFn = (
  dir: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => { close(): void; on?(event: "error", listener: (error: Error) => void): unknown };

export interface WatchOptions {
  onError?: () => void;
  /** Coalescing window. A single save can produce several rename/change events. */
  debounceMs?: number;
  /**
   * Drop events we caused ourselves. `commit` sets a `suppressUntil` timestamp,
   * so an apply does not bounce straight back through the watcher and rerun the
   * checks it already reran.
   */
  suppress?: () => boolean;
  /** Injected for tests. */
  watch?: WatchFn;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export function watchSettings(
  dir: string,
  file: string,
  onChange: () => void,
  options: WatchOptions = {},
): SettingsWatcher {
  const debounceMs = options.debounceMs ?? 1000;
  const suppress = options.suppress ?? (() => false);
  const watch: WatchFn =
    options.watch ?? ((target, listener) => nodeFs.watch(target, { persistent: false }, listener));
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;

  const basename = path.basename(file);
  const parent = path.dirname(dir);
  const dirname = path.basename(dir);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let watcher: { close(): void } | undefined;
  let pending: { close(): void } | undefined;
  let reported = false;

  function report(): void {
    if (closed || reported) return;
    reported = true;
    options.onError?.();
  }

  function queue(): void {
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      // Checked when the debounce fires, not when the event arrives: our own
      // write produces events both before and after the suppression window
      // opens, and the trailing ones are the ones that matter.
      if (closed || suppress()) return;
      onChange();
    }, debounceMs);
  }

  /** Arm on `dir` itself. Returns false when it still does not exist. */
  function arm(): boolean {
    if (closed || watcher !== undefined) return true;
    try {
      const active = watch(dir, (_event, filename) => {
        if (closed) return;
        // A null filename means the platform could not tell us which entry
        // changed (it happens on some macOS and Windows paths). Treating it as
        // a hit costs one extra health run; treating it as a miss costs a stale
        // panel, which is the failure the user notices.
        const name = filename === null ? basename : filename.toString();
        if (name !== basename) return;
        queue();
      });
      active.on?.("error", () => {
        active.close();
        if (watcher === active) watcher = undefined;
        report();
      });
      watcher = active;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report();
      return false;
    }
    pending?.close();
    pending = undefined;
    return true;
  }

  /**
   * Wait one level up for `~/.claude` to be created. The parent watch is a
   * placeholder, not a second source of truth: it is closed the moment the real
   * one arms, so the home directory's churn never reaches the health runner.
   */
  function waitForParent(): void {
    if (closed || watcher !== undefined || pending !== undefined) return;
    // `path.dirname('/')` is `/`: at a filesystem root there is no level up,
    // and watching the same directory again would just re-throw.
    if (parent === dir) return;
    try {
      const active = watch(parent, (_event, filename) => {
        if (closed || watcher !== undefined) return;
        // An unnamed event could be the directory we are waiting for, so try.
        const name = filename === null ? dirname : filename.toString();
        if (name !== dirname) return;
        // The write that created the directory happened before anything was
        // listening for it, so arming is itself news: run the checks once.
        if (arm()) queue();
      });
      active.on?.("error", () => {
        active.close();
        if (pending === active) pending = undefined;
        report();
      });
      pending = active;
    } catch {
      // Neither the directory nor its parent is watchable — an unusual home
      // directory, or a platform that refuses. The panel still refreshes on
      // demand, and failing activation over it would be far worse.
      pending = undefined;
      report();
    }
  }

  if (!arm()) waitForParent();

  return {
    rearm(): void {
      if (closed) return;
      if (!arm()) waitForParent();
    },
    dispose(): void {
      closed = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      watcher?.close();
      watcher = undefined;
      pending?.close();
      pending = undefined;
    },
  };
}
