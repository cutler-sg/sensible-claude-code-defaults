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
    // Duplicate top-level keys are last-one-wins here and in Claude Code's own
    // `JSON.parse`, so the shadowed copy is already dead to the user; a write
    // collapses it, which matches what Claude Code was reading all along (F16).
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "malformed", raw, error: parseErrorMessage(error, text) };
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

/**
 * Hard rule 4: describe *where* the file broke, never *what is in it*.
 *
 * V8's `SyntaxError.message` quotes roughly twenty characters of the document
 * around the fault ("Unexpected token 'A', ...\"BEDROCK\": ABSKtest12\"... is
 * not valid JSON"), and the single most likely way for a user to corrupt this
 * particular file is pasting a Bedrock bearer token in unquoted — which puts
 * the token itself inside the quoted window. So the parser's message never
 * reaches a string we render or log. A character offset is derived from it when
 * V8 supplies one, because that is a coordinate rather than content.
 */
function parseErrorMessage(error: unknown, text: string): string {
  const position = offsetOf(error);
  if (position === undefined) {
    return NOT_VALID_JSON;
  }
  const { line, column } = lineAndColumn(text, position);
  return `${NOT_VALID_JSON} — the problem is at line ${line}, column ${column} (character ${position}).`;
}

const NOT_VALID_JSON = "settings.json is not valid JSON";

/** V8 appends "at position N" to some, not all, of its parse failures. */
function offsetOf(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : "";
  const match = /at position (\d+)/.exec(message);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const position = Number.parseInt(match[1], 10);
  return Number.isFinite(position) ? position : undefined;
}

/** 1-based, counting the LF-delimited lines of the text that was parsed. */
function lineAndColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(position, text.length)));
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: before.length - lastBreak };
}

/** Render `data` back out in the style the file was read in. */
export function serialize(data: Settings, style: FileStyle): string {
  const eol = style.eol ?? "\n";
  // `JSON.stringify` always emits LF and escapes any newline inside a string
  // value as `\\n`, so every literal LF in `text` is structural and safe to
  // rewrite. A CRLF file that came back LF would show up as a whole-file diff
  // in the user's dotfiles repo (F11).
  const text = JSON.stringify(data, null, style.indent).replaceAll("\n", eol);
  return style.trailingNewline ? `${text}${eol}` : text;
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
    // First CRLF wins: a file mixing both was already inconsistent, and the
    // majority ending is not worth a second pass over the text.
    eol: text.includes("\r\n") ? "\r\n" : "\n",
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
