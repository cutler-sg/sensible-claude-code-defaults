import * as vscode from "vscode";
import type { Logger } from "../util/log.js";

export class KeychainSaveError extends Error {
  constructor(cause: unknown) {
    super(
      "Your key couldn't be saved securely. Unlock your system keychain or ask IT to check VS Code secret storage, then try again.",
      { cause },
    );
  }
}

/** Translate filesystem causes without putting paths or file contents in the UI. */
export function failureMessage(error: unknown, fallback: string): string {
  const seen = new Set<unknown>();
  let cause = error;
  while (typeof cause === "object" && cause !== null && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof KeychainSaveError) return cause.message;
    const code = "code" in cause ? cause.code : undefined;
    if (code === "EACCES" || code === "EPERM") {
      return "Your device blocked access to a required file or folder. Ask your IT team to allow Claude Code settings in your user profile, then try again.";
    }
    if (code === "EROFS") {
      return "The settings location is read-only. Ask your IT team for a writable Claude Code settings location, then try again.";
    }
    if (code === "ENOSPC" || code === "EDQUOT") {
      return "There isn't enough available storage to finish saving your settings. Free some space or ask your IT team about your storage quota, then try again.";
    }
    if (code === "ENOTDIR") {
      return "A file is blocking the folder Claude Code needs for its settings. Ask your IT team to check the settings location, then try again.";
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return fallback;
}

/** A failed notification or output channel must not escape a failure handler. */
export async function reportFailure(
  log: Pick<Logger, "error">,
  message: string,
  notify = true,
): Promise<void> {
  try {
    log.error(message);
  } catch {
    console.error(message);
  }
  if (!notify) return;
  try {
    await vscode.window.showErrorMessage(message);
  } catch {
    console.error(message);
  }
}
