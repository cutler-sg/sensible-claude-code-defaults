/**
 * Reading `settings.json` without ever losing what is in it.
 *
 * A read reports one of three states — absent, ok, malformed — and never
 * throws for content reasons. FR-2.5: a file we cannot parse is a file we must
 * not overwrite, so `malformed` carries the raw text through to the UI.
 */

import * as fs from "node:fs/promises";
import { DEFAULT_STYLE, type FileStyle, type ReadResult, type Settings } from "./types.js";

const BOM = "﻿";

export async function readSettings(file: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    // EACCES, EISDIR, ELOOP and friends are host problems, not content
    // problems: the caller must not mistake them for "no settings yet".
    throw error;
  }

  // A BOM is legal in a file Claude Code reads but not in `JSON.parse` input.
  // We strip it for parsing and never write one back, so a BOM'd file loses
  // its BOM on the first write — deliberate, and invisible to every consumer.
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;

  let parsed: unknown;
  try {
    // Strict JSON on purpose. Claude Code's own loader is strict, so comments
    // and trailing commas are already broken for the user; accepting them here
    // would let us rewrite a file into a shape Claude Code silently ignores.
    parsed = JSON.parse(text);
  } catch (error) {
    // JSON.parse only ever throws SyntaxError, so the message is always there.
    const message = (error as SyntaxError).message;
    return { kind: "malformed", raw, error: `settings.json is not valid JSON: ${message}` };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: "malformed",
      raw,
      error: `settings.json must contain a JSON object at the top level, found ${describe(parsed)}.`,
    };
  }

  if ("env" in parsed && !isPlainObject(parsed.env)) {
    return {
      kind: "malformed",
      raw,
      error: `settings.json has an "env" key that is not an object (found ${describe(parsed.env)}); refusing to touch it.`,
    };
  }

  return { kind: "ok", data: parsed as Settings, style: detectStyle(text), raw };
}

/** Render `data` back out in the style the file was read in. */
export function serialize(data: Settings, style: FileStyle): string {
  const text = JSON.stringify(data, null, style.indent);
  return style.trailingNewline ? `${text}\n` : text;
}

/**
 * Detect indentation and trailing newline so a write does not reformat a file
 * the user hand-edited. Indent comes from the first line that opens with
 * whitespace followed by a quoted key — that is a top-level member of the root
 * object, so its leading whitespace is exactly one indent level.
 */
function detectStyle(text: string): FileStyle {
  const match = /^([ \t]+)"/m.exec(text);
  return {
    indent: match?.[1] ?? DEFAULT_STYLE.indent,
    trailingNewline: text.endsWith("\n"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}
