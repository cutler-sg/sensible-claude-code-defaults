import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WatchFn, watchSettings } from "../../../src/ui/watcher.js";

interface Fake {
  watch: WatchFn;
  emit(filename: string | null): void;
  dir: string | undefined;
  closed: boolean;
}

function fakeWatch(): Fake {
  const fake: Fake = {
    dir: undefined,
    closed: false,
    emit: () => {
      throw new Error("no listener registered");
    },
    watch: (dir, listener) => {
      fake.dir = dir;
      fake.emit = (filename) => listener("rename", filename);
      return {
        close() {
          fake.closed = true;
        },
      };
    },
  };
  return fake;
}

describe("watchSettings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("watches the parent directory, not the file (atomic-rename writers)", () => {
    const fake = fakeWatch();
    watchSettings("/home/u/.claude", "/home/u/.claude/settings.json", () => {}, {
      watch: fake.watch,
    });
    expect(fake.dir).toBe("/home/u/.claude");
  });

  it("coalesces a burst of events into one run", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings("/d", "/d/settings.json", onChange, { watch: fake.watch });

    fake.emit("settings.json");
    vi.advanceTimersByTime(500);
    fake.emit("settings.json");
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores other files in the directory", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings("/d", "/d/settings.json", onChange, { watch: fake.watch });

    fake.emit("settings.json.tmp-1234");
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats an unnamed event as a hit — a stale panel is the worse failure", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings("/d", "/d/settings.json", onChange, { watch: fake.watch });

    fake.emit(null);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops events while our own write is suppressed", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    let suppressed = true;
    watchSettings("/d", "/d/settings.json", onChange, {
      watch: fake.watch,
      suppress: () => suppressed,
    });

    fake.emit("settings.json");
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();

    suppressed = false;
    fake.emit("settings.json");
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("honours a custom debounce window", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchSettings("/d", "/d/settings.json", onChange, { watch: fake.watch, debounceMs: 50 });

    fake.emit("settings.json");
    vi.advanceTimersByTime(49);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes the watcher and cancels a pending run on dispose", () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const sub = watchSettings("/d", "/d/settings.json", onChange, { watch: fake.watch });

    fake.emit("settings.json");
    sub.dispose();
    vi.advanceTimersByTime(5000);

    expect(fake.closed).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("survives a missing directory rather than failing activation", () => {
    const onChange = vi.fn();
    const sub = watchSettings("/nope", "/nope/settings.json", onChange, {
      watch: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(() => sub.dispose()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
