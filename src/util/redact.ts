/**
 * Single choke point for scrubbing secrets out of anything the extension emits:
 * log lines, error messages, diagnostics output.
 *
 * M0 ships the identity function deliberately — the boundary has to exist from the
 * first log statement so nothing is ever written that bypasses it. M5 (FR-7,
 * §10.4) fills in the actual patterns: the Bedrock bearer token, AWS access keys,
 * and anything else the leak scan learns to recognise.
 */
export function redact(message: string): string {
  return message;
}
