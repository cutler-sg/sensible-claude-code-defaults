import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WatchFn, watchSettings } from "../../../src/ui/watcher.js";

/**
 * A directory-aware `fs.watch` stand-in: the watcher arms on `~/.claude` when
 * it exists and on its parent when it does not, so a fake that models a single
 * directory cannot express the case that matters (a fresh install).
 */
interface Fake {
  watch: WatchFn;
  /** Directories with a live watch on them, in the order they were armed. */
  watching(): string[];
  emit(dir: string, filename: string | null): void;
  /** Deliver an event to a listener whose watch has since been closed. */
  emitDetached(dir: string, filename: string | null): void;
  /** Make a missing directory exist, without announcing it. */
  appear(dir: string): void;
  /** Make a missing directory appear, and tell its parent's watcher about it. */
  create(dir: string): void;
}

function fakeWatch(missing: readonly string[] = []): Fake {
  type Listener = (event: string, filename: string | Buffer | null) => void;
  const absent = new Set(missing);
  const live = new Map<string, Listener>();
  const everSeen = new Map<string, Listener>();

  const fake: Fake = {
    watching: () => [...live.keys()],
    emit(dir, filename) {
      const listener = live.get(dir);
      if (listener === undefined) throw new Error(`nothing is watching ${dir}`);
      listener("rename", filename);
    },
    emitDetached(dir, filename) {
      const listener = everSeen.get(dir);
      if (listener === undefined) throw new Error(`${dir} was never watched`);
      listener("rename", filename);
    },
    appear(dir) {
      absent.delete(dir);
    },
    create(dir) {
      fake.appear(dir);
      const at = dir.lastIndexOf("/");
      fake.emit(dir.slice(0, at), dir.slice(at + 1));
    },
    watch: (dir, listener) => {
      if (absent.has(dir)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      live.set(dir, listener);
      everSeen.set(dir, listener);
      return {
        close() {
          live.delete(dir);
        },
      };
    },
  };
  return fake;
}

const CLAUDE_DIR = "/home/u/.claude";
const SETTINGS = "/home/u/.claude/settings.json";

describe("watchSettings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("watches the parent directory, not the file (atomic-rename writers)", () => {
    const fake = fakeWatch();
    watchSettings(CLAUDE_DIR, SETTINGS, () => {}, { watch: fake.watch });
    expect(fake.watching()).toEqual([CLAUDE_DIR]);
  });

  it("coalesces a burst of events into one run", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });

    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(500);
    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores other files in the directory", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });

    fake.emit(CLAUDE_DIR, "settings.json.tmp-1234");
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats an unnamed event as a hit — a stale panel is the worse failure", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });

    fake.emit(CLAUDE_DIR, null);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops events while our own write is suppressed", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    let suppressed = true;
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, {
      watch: fake.watch,
      suppress: () => suppressed,
    });

    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();

    suppressed = false;
    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("honours a custom debounce window", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch, debounceMs: 50 });

    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(49);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes the watcher and cancels a pending run on dispose", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const sub = watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });

    fake.emit(CLAUDE_DIR, "settings.json");
    sub.dispose();
    vi.advanceTimersByTime(5000);

    expect(fake.watching()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("watchSettings on a fresh install (no ~/.claude yet)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits on the parent, then re-arms on the real directory when it appears", () => {
    const fake = fakeWatch([CLAUDE_DIR]);
    const onChange = vi.fn();
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });

    expect(fake.watching()).toEqual(["/home/u"]);

    fake.create(CLAUDE_DIR);
    // The parent watch exists only to catch this moment, and holding it open
    // would deliver every unrelated change in the home directory.
    expect(fake.watching()).toEqual([CLAUDE_DIR]);

    // The directory almost never appears empty — Claude Code creates it and
    // writes settings.json in the same breath, and that write happened before
    // there was anything to hear it, so the arrival is itself a change.
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);

    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ignores its siblings while it waits", () => {
    const fake = fakeWatch([CLAUDE_DIR]);
    const onChange = vi.fn();
    watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });

    fake.emit("/home/u", ".bashrc");
    vi.advanceTimersByTime(5000);
    expect(fake.watching()).toEqual(["/home/u"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tries again on an unnamed parent event, since it cannot know what appeared", () => {
    const fake = fakeWatch([CLAUDE_DIR]);
    watchSettings(CLAUDE_DIR, SETTINGS, () => {}, { watch: fake.watch });

    fake.emit("/home/u", null);
    expect(fake.watching()).toEqual(["/home/u"]);

    fake.create(CLAUDE_DIR);
    expect(fake.watching()).toEqual([CLAUDE_DIR]);
  });

  it("re-arms on demand when the parent event never arrived", () => {
    const fake = fakeWatch([CLAUDE_DIR]);
    const onChange = vi.fn();
    const sub = watchSettings(CLAUDE_DIR, SETTINGS, onChange, { watch: fake.watch });
    expect(fake.watching()).toEqual(["/home/u"]);

    // `commit` creating `~/.claude` is the one moment we know the directory
    // exists without being told by the platform — inotify on the parent can
    // coalesce a mkdir+write into events we have already read past.
    fake.appear(CLAUDE_DIR);
    sub.rearm();
    expect(fake.watching()).toEqual([CLAUDE_DIR]);

    fake.emit(CLAUDE_DIR, "settings.json");
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-arming an already-armed watch is a no-op", () => {
    const fake = fakeWatch();
    const sub = watchSettings(CLAUDE_DIR, SETTINGS, () => {}, { watch: fake.watch });
    sub.rearm();
    sub.rearm();
    expect(fake.watching()).toEqual([CLAUDE_DIR]);
  });

  it("keeps waiting when the parent is unwatchable too", () => {
    const fake = fakeWatch([CLAUDE_DIR, "/home/u"]);
    const sub = watchSettings(CLAUDE_DIR, SETTINGS, () => {}, { watch: fake.watch });
    expect(fake.watching()).toEqual([]);
    expect(() => sub.dispose()).not.toThrow();
  });

  it("does not watch above a filesystem root", () => {
    const fake = fakeWatch(["/"]);
    watchSettings("/", "/settings.json", () => {}, { watch: fake.watch });
    expect(fake.watching()).toEqual([]);
  });

  it("stops re-arming once disposed", () => {
    const fake = fakeWatch([CLAUDE_DIR]);
    const sub = watchSettings(CLAUDE_DIR, SETTINGS, () => {}, { watch: fake.watch });
    sub.dispose();
    sub.rearm();
    expect(fake.watching()).toEqual([]);
  });

  it("ignores a parent event that arrives after disposal", () => {
    const fake = fakeWatch([CLAUDE_DIR]);
    const sub = watchSettings(CLAUDE_DIR, SETTINGS, () => {}, { watch: fake.watch });

    // `close()` does not always drain the queue: an event can still land after
    // dispose(), and re-arming then would leak a watch nothing ever closes.
    sub.dispose();
    fake.appear(CLAUDE_DIR);
    fake.emitDetached("/home/u", ".claude");
    expect(fake.watching()).toEqual([]);
  });
});
