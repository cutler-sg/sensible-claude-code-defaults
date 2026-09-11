import type { LogOutputChannel } from "vscode";
import { redact } from "./redact.js";

/**
 * Thin wrapper over a `LogOutputChannel` whose only job is to guarantee that
 * every string reaching the output channel has passed through `redact`.
 */
export class Logger {
  constructor(private readonly channel: LogOutputChannel) {}

  info(message: string): void {
    this.channel.info(redact(message));
  }

  warn(message: string): void {
    this.channel.warn(redact(message));
  }

  error(message: string): void {
    this.channel.error(redact(message));
  }
}
