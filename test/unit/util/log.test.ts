import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger, RING_SIZE } from "../../../src/util/log.js";
import { forgetAll, REDACTED, register } from "../../../src/util/redact.js";

/** Records what actually reached the channel, so redaction can be asserted there too. */
class FakeChannel {
  readonly written: string[] = [];

  info(message: string): void {
    this.written.push(`info ${message}`);
  }

  warn(message: string): void {
    this.written.push(`warn ${message}`);
  }

  error(message: string): void {
    this.written.push(`error ${message}`);
  }
}

/** Matches none of `redact.ts`'s patterns, so only the registry can catch it. */
const SECRET = "Zq7Xk2Mv9Tb4Rn6Wc8Jd3Fp5Hs1Ly0Gu";

let channel: FakeChannel;
let log: Logger;

beforeEach(() => {
  forgetAll();
  channel = new FakeChannel();
  log = new Logger(channel as never);
});

afterEach(() => {
  forgetAll();
});

describe("Logger", () => {
  it("writes each level to the channel", () => {
    log.info("one");
    log.warn("two");
    log.error("three");

    expect(channel.written).toEqual(["info one", "warn two", "error three"]);
  });

  it("keeps every line it wrote, in order, with its level", () => {
    log.info("one");
    log.error("two");

    expect(log.recent()).toEqual([
      { level: "info", message: "one" },
      { level: "error", message: "two" },
    ]);
  });

  it(`holds at most ${RING_SIZE} lines, dropping the oldest`, () => {
    for (let i = 0; i < RING_SIZE + 10; i += 1) log.info(`line ${i}`);

    const kept = log.recent();

    expect(kept).toHaveLength(RING_SIZE);
    expect(kept[0]?.message).toBe("line 10");
    expect(kept.at(-1)?.message).toBe(`line ${RING_SIZE + 9}`);
  });

  /**
   * The ring holds the redacted text, not the original. A buffer of raw lines
   * waiting to be scrubbed on the way into the report would be one more place a
   * token lives, and the report is the artefact a user pastes in public.
   */
  it.each(["info", "warn", "error"] as const)("redacts a %s line on the way in", (level) => {
    register(SECRET);

    log[level](`token ${SECRET} used`);

    expect(log.recent()).toEqual([{ level, message: `token ${REDACTED} used` }]);
    expect(channel.written).toEqual([`${level} token ${REDACTED} used`]);
  });

  it("redacts a value registered before the line was written", () => {
    register(SECRET);
    log.info(`saved ${SECRET}`);
    forgetAll();

    // Still redacted after the registry is cleared: the scrubbing happened when
    // the line was buffered, so a `forgetAll` on deactivate cannot resurrect a
    // value the report is about to include.
    expect(log.recent()[0]?.message).toBe(`saved ${REDACTED}`);
  });

  it("hands out copies, so a caller cannot mutate the buffer", () => {
    log.info("one");

    const first = log.recent();
    const line = first[0];
    if (line === undefined) throw new Error("the ring lost its only line");
    line.message = "tampered";

    expect(log.recent()[0]?.message).toBe("one");
    expect(log.recent()).not.toBe(first);
  });

  it("starts empty", () => {
    expect(log.recent()).toEqual([]);
  });
});
