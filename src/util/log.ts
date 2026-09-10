import type { LogOutputChannel } from "vscode";
import { redact } from "./redact.js";

/**
 * Thin wrapper over a `LogOutputChannel` whose only job is to guarantee that
 * every string reaching the output channel has passed through `redact`.
 *
 * It also keeps the last `RING_SIZE` lines for FR-7.1's diagnostics report. The
 * ring holds the *redacted* text, not the original: the report is the artefact
 * a user pastes into a public issue, and a buffer of raw lines waiting to be
 * scrubbed on the way out would be one more place a token lives. Keeping it
 * here rather than reading the channel back is not a convenience either —
 * `LogOutputChannel` is write-only, so this is the only way to have the lines
 * at all, and putting it behind the same choke point means a line cannot reach
 * the report without having reached `redact` first.
 */

/** FR-7.1: "the last 50 output-channel lines". */
export const RING_SIZE = 50;

/** How a line is stamped in the diagnostics report. */
export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  level: LogLevel;
  /** Already redacted. */
  message: string;
}

export class Logger {
  /** Newest last. Trimmed from the front, so it never exceeds `RING_SIZE`. */
  readonly #ring: LogLine[] = [];

  constructor(private readonly channel: LogOutputChannel) {}

  info(message: string): void {
    this.channel.info(this.#keep("info", message));
  }

  warn(message: string): void {
    this.channel.warn(this.#keep("warn", message));
  }

  error(message: string): void {
    this.channel.error(this.#keep("error", message));
  }

  /**
   * The last `RING_SIZE` lines, oldest first — the order a reader expects and
   * the order the channel shows them in. A copy, so a caller holding the result
   * cannot mutate the buffer or watch it change under them.
   */
  recent(): LogLine[] {
    return this.#ring.map((line) => ({ ...line }));
  }

  #keep(level: LogLevel, message: string): string {
    const redacted = redact(message);
    this.#ring.push({ level, message: redacted });
    if (this.#ring.length > RING_SIZE) this.#ring.splice(0, this.#ring.length - RING_SIZE);
    return redacted;
  }
}

/**
 * What the diagnostics report needs from a `Logger`. Narrower than the class so
 * `report.ts` can be handed a plain object in a test, and satisfied by the real
 * `Logger`.
 */
export interface RecentLog {
  recent(): readonly LogLine[];
}
