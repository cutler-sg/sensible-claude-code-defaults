/**
 * Watch `settings.json` for changes made outside the extension (plan Q-Q).
 *
 * Watches the *parent directory*, not the file: Claude Code and this extension
 * both write settings atomically (write temp, rename over), which replaces the
 * inode. A watch on the file itself follows the old inode and goes deaf after
 * the first such write. `vscode.workspace.createFileSystemWatcher` is not an
 * option either — it is workspace-scoped, and `~/.claude` is not in the
 * workspace.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";

export interface Disposable {
  dispose(): void;
}

/** The subset of `fs.watch` this needs, so tests can inject a fake. */
export type WatchFn = (
  dir: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => { close(): void };

export interface WatchOptions {
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
): Disposable {
  const debounceMs = options.debounceMs ?? 1000;
  const suppress = options.suppress ?? (() => false);
  const watch: WatchFn =
    options.watch ?? ((target, listener) => nodeFs.watch(target, { persistent: false }, listener));
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;

  const basename = path.basename(file);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  let watcher: { close(): void } | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (closed) return;
      // A null filename means the platform could not tell us which entry
      // changed (it happens on some macOS and Windows paths). Treating it as a
      // hit costs one extra health run; treating it as a miss costs a stale
      // panel, which is the failure the user notices.
      const name = filename === null ? basename : filename.toString();
      if (name !== basename) return;
      if (timer !== undefined) cancel(timer);
      timer = schedule(() => {
        timer = undefined;
        // Checked when the debounce fires, not when the event arrives: our own
        // write produces events both before and after the suppression window
        // opens, and the trailing ones are the ones that matter.
        if (closed || suppress()) return;
        onChange();
      }, debounceMs);
    });
  } catch {
    // A missing `~/.claude` is normal on a fresh install. Without a watcher the
    // panel simply refreshes on demand instead of automatically; failing
    // activation over it would be far worse.
    watcher = undefined;
  }

  return {
    dispose(): void {
      closed = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      watcher?.close();
    },
  };
}
