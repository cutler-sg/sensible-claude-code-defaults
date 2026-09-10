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
    });
  });

  it("detects four-space indent", async () => {
    await write('{\n    "a": 1\n}\n');
    expect(await style()).toEqual({ indent: "    ", trailingNewline: true });
  });

  it("detects tab indent", async () => {
    await write('{\n\t"a": 1\n}\n');
    expect(await style()).toEqual({ indent: "\t", trailingNewline: true });
  });

  it("falls back to the default indent for a single-line {}", async () => {
    await write("{}\n");
    expect(await style()).toEqual({ indent: DEFAULT_STYLE.indent, trailingNewline: true });
  });

  it("falls back to the default indent for a single-line object with keys", async () => {
    await write('{"a": 1}');
    expect(await style()).toEqual({ indent: DEFAULT_STYLE.indent, trailingNewline: false });
  });

  it("records a missing trailing newline", async () => {
    await write('{\n  "a": 1\n}');
    expect(await style()).toEqual({ indent: "  ", trailingNewline: false });
  });

  it("takes the indent from the first indented key, not a deeper one", async () => {
    await write('{\n  "env": {\n      "A": "1"\n  }\n}\n');
    expect(await style()).toEqual({ indent: "  ", trailingNewline: true });
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

describe("readSettings — I/O errors propagate", () => {
  it.skipIf(process.getuid?.() === 0)("does not swallow EACCES", async () => {
    await write("{}\n");
    await fs.chmod(file, 0o000);
    try {
      await expect(readSettings(file)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await fs.chmod(file, 0o600);
    }
  });

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
