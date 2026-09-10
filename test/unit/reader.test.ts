import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettings, serialize } from "../../src/config/reader.js";
import { DEFAULT_STYLE } from "../../src/config/types.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scd-reader-"));
  file = path.join(dir, "settings.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(text: string): Promise<void> {
  await fs.writeFile(file, text, "utf8");
}

describe("readSettings — absent", () => {
  it("reports absent when the file does not exist", async () => {
    expect(await readSettings(file)).toEqual({ kind: "absent" });
  });

  it("reports absent when the parent directory does not exist", async () => {
    const result = await readSettings(path.join(dir, "nope", "settings.json"));
    expect(result.kind).toBe("absent");
  });
});

describe("readSettings — ok", () => {
  it("parses an object and returns the raw text", async () => {
    const raw = '{\n  "env": {\n    "AWS_REGION": "us-east-1"\n  }\n}\n';
    await write(raw);
    const result = await readSettings(file);
    expect(result).toMatchObject({
      kind: "ok",
      data: { env: { AWS_REGION: "us-east-1" } },
      raw,
    });
  });

  it("detects two-space indent", async () => {
    await write('{\n  "a": 1\n}\n');
    const result = await readSettings(file);
    expect(result.kind === "ok" && result.style).toEqual({
      indent: "  ",
      trailingNewline: true,
      eol: "\n",
    });
  });

  it("detects four-space indent", async () => {
    await write('{\n    "a": 1\n}\n');
    expect(await style()).toEqual({ indent: "    ", trailingNewline: true, eol: "\n" });
  });

  it("detects tab indent", async () => {
    await write('{\n\t"a": 1\n}\n');
    expect(await style()).toEqual({ indent: "\t", trailingNewline: true, eol: "\n" });
  });

  it("falls back to the default indent for a single-line {}", async () => {
    await write("{}\n");
    expect(await style()).toEqual({
      indent: DEFAULT_STYLE.indent,
      trailingNewline: true,
      eol: "\n",
    });
  });

  it("falls back to the default indent for a single-line object with keys", async () => {
    await write('{"a": 1}');
    expect(await style()).toEqual({
      indent: DEFAULT_STYLE.indent,
      trailingNewline: false,
      eol: "\n",
    });
  });

  it("records a missing trailing newline", async () => {
    await write('{\n  "a": 1\n}');
    expect(await style()).toEqual({ indent: "  ", trailingNewline: false, eol: "\n" });
  });

  it("takes the indent from the first indented key, not a deeper one", async () => {
    await write('{\n  "env": {\n      "A": "1"\n  }\n}\n');
    expect(await style()).toEqual({ indent: "  ", trailingNewline: true, eol: "\n" });
  });

  it("strips a UTF-8 BOM before parsing but keeps it in raw", async () => {
    const body = '{\n  "a": 1\n}\n';
    await write(`﻿${body}`);
    const result = await readSettings(file);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.data).toEqual({ a: 1 });
    expect(result.raw.startsWith("﻿")).toBe(true);
    expect(result.style.indent).toBe("  ");
  });

  it("accepts an empty object", async () => {
    await write("{}");
    const result = await readSettings(file);
    expect(result.kind === "ok" && result.data).toEqual({});
  });

  it("accepts an env object alongside unmanaged keys", async () => {
    await write('{\n  "$schema": "https://x", "env": {}, "model": "opus"\n}\n');
    const result = await readSettings(file);
    expect(result.kind).toBe("ok");
  });

  async function style() {
    const result = await readSettings(file);
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.kind}`);
    }
    return result.style;
  }
});

describe("readSettings — malformed (FR-2.5)", () => {
  const cases: Array<[name: string, text: string, matcher: RegExp]> = [
    ["a trailing comma", '{\n  "a": 1,\n}\n', /not valid JSON/],
    ["a // comment", '{\n  // pinned\n  "a": 1\n}\n', /not valid JSON/],
    ["an empty file", "", /not valid JSON/],
    ["whitespace only", "   \n", /not valid JSON/],
    ["a root array", '["a"]\n', /object at the top level, found an array/],
    ["a root null", "null\n", /object at the top level, found null/],
    ["a root string", '"hello"\n', /object at the top level, found a string/],
    ["a root number", "42\n", /object at the top level, found a number/],
    [
      "env as a string",
      '{\n  "env": "AWS_REGION=us-east-1"\n}\n',
      /"env" key that is not an object/,
    ],
    ["env as an array", '{\n  "env": []\n}\n', /found an array/],
    ["env as null", '{\n  "env": null\n}\n', /found null/],
  ];

  for (const [name, text, matcher] of cases) {
    it(`rejects ${name}`, async () => {
      await write(text);
      const result = await readSettings(file);
      expect(result.kind).toBe("malformed");
      if (result.kind !== "malformed") {
        return;
      }
      expect(result.error).toMatch(matcher);
      // The raw text must survive so the UI can offer "open the file".
      expect(result.raw).toBe(text);
    });
  }
});

/**
 * Hard rule 4. The realistic corruption for this file is a Bedrock bearer token
 * pasted in unquoted, and V8's own `SyntaxError.message` quotes ~20 characters
 * of the document around the fault — which is the token. The reader must
 * therefore never pass the parser's message on.
 */
describe("readSettings — the parse error never quotes file content", () => {
  const TOKEN = "ABSKtest123456789012345678901234567890";

  /** Every 8-character window of the token: one hit is a leak. */
  function windows(secret: string, size = 8): string[] {
    return Array.from({ length: secret.length - size + 1 }, (_, at) => secret.slice(at, at + size));
  }

  it("does not echo an unquoted pasted token back in the error", async () => {
    await write(`{\n  "env": {\n    "AWS_BEARER_TOKEN_BEDROCK": ${TOKEN}\n  }\n}\n`);
    const result = await readSettings(file);
    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    for (const window of windows(TOKEN)) {
      expect(result.error).not.toContain(window);
    }
    // The bytes still reach the caller — FR-2.5 needs them to refuse the write.
    expect(result.raw).toContain(TOKEN);
  });

  it("does not echo a quoted secret value that trips a later parse fault", async () => {
    await write(`{\n  "env": {"AWS_BEARER_TOKEN_BEDROCK": "${TOKEN}",}\n}\n`);
    const result = await readSettings(file);
    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    for (const window of windows(TOKEN)) {
      expect(result.error).not.toContain(window);
    }
  });

  it("reports a position as line/column/character when V8 supplies one", async () => {
    await write('{\n  "a": 1,\n}\n');
    const result = await readSettings(file);
    expect(result.kind === "malformed" && result.error).toMatch(
      /^settings\.json is not valid JSON — the problem is at line 3, column 1 \(character \d+\)\.$/,
    );
  });

  it("falls back to the fixed string when V8 supplies no position", async () => {
    // "Unexpected end of JSON input" carries no `at position N`.
    await write("");
    const result = await readSettings(file);
    expect(result.kind === "malformed" && result.error).toBe("settings.json is not valid JSON");
  });

  it("counts the line from the parsed text, so a BOM does not shift it", async () => {
    await write('\uFEFF{\n  "a": 1,\n}\n');
    const result = await readSettings(file);
    expect(result.kind === "malformed" && result.error).toContain("line 3, column 1");
  });
});

describe("readSettings — I/O errors propagate", () => {
  // Root bypasses the mode bits, and Windows does not have them at all: a
  // `chmod(0o000)` there is a no-op and the read simply succeeds. Neither case
  // says anything about whether the error is swallowed, which is the assertion.
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "does not swallow EACCES",
    async () => {
      await write("{}\n");
      await fs.chmod(file, 0o000);
      try {
        await expect(readSettings(file)).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(file, 0o600);
      }
    },
  );

  it("does not report a directory as absent", async () => {
    const asDir = path.join(dir, "adir");
    await fs.mkdir(asDir);
    await expect(readSettings(asDir)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("serialize", () => {
  it("round-trips through the detected style", async () => {
    const raw = '{\n\t"env": {\n\t\t"AWS_REGION": "us-east-1"\n\t}\n}\n';
    await write(raw);
    const result = await readSettings(file);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(serialize(result.data, result.style)).toBe(raw);
  });

  it("omits the trailing newline when the file had none", () => {
    expect(serialize({ a: 1 }, { indent: "  ", trailingNewline: false })).toBe('{\n  "a": 1\n}');
  });

  it("uses the given indent", () => {
    expect(serialize({ a: 1 }, { indent: "    ", trailingNewline: true })).toBe(
      '{\n    "a": 1\n}\n',
    );
  });
});

describe("line endings (F11)", () => {
  it("detects CRLF from the first occurrence in the file", async () => {
    await write('{\r\n  "a": 1\r\n}\r\n');
    expect(await styleOf()).toEqual({ indent: "  ", trailingNewline: true, eol: "\r\n" });
  });

  it("detects LF for a file with no carriage returns", async () => {
    await write('{\n  "a": 1\n}\n');
    expect(await styleOf()).toEqual({ indent: "  ", trailingNewline: true, eol: "\n" });
  });

  it("round-trips a CRLF file byte-for-byte", async () => {
    const raw = '{\r\n  "env": {\r\n    "AWS_REGION": "us-east-1"\r\n  }\r\n}\r\n';
    await write(raw);
    const result = await readSettings(file);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(serialize(result.data, result.style)).toBe(raw);
  });

  it("keeps an LF file on LF", () => {
    expect(serialize({ a: 1 }, { indent: "  ", trailingNewline: true, eol: "\n" })).toBe(
      '{\n  "a": 1\n}\n',
    );
  });

  it("uses the detected eol for the trailing newline too", () => {
    expect(serialize({ a: 1 }, { indent: "  ", trailingNewline: true, eol: "\r\n" })).toBe(
      '{\r\n  "a": 1\r\n}\r\n',
    );
  });

  it("omits the trailing eol when the file had none", () => {
    expect(serialize({ a: 1 }, { indent: "  ", trailingNewline: false, eol: "\r\n" })).toBe(
      '{\r\n  "a": 1\r\n}',
    );
  });

  it("does not corrupt a string value containing an escaped newline", () => {
    const out = serialize({ a: "x\ny" }, { indent: "  ", trailingNewline: true, eol: "\r\n" });
    expect(out).toBe('{\r\n  "a": "x\\ny"\r\n}\r\n');
    expect(JSON.parse(out)).toEqual({ a: "x\ny" });
  });

  async function styleOf() {
    const result = await readSettings(file);
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.kind}`);
    }
    return result.style;
  }
});
