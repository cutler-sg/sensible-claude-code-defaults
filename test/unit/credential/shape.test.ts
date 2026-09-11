import { describe, expect, it } from "vitest";
import {
  normalizeToken,
  SHAPE_MESSAGES,
  validateTokenShape,
} from "../../../src/credential/shape.js";
import type { ShapeProblem } from "../../../src/credential/types.js";

/** A realistic long-term key: `ABSK` plus 80 base64-ish characters. */
const LONG_TERM = `ABSK${"QmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZTAxMjM0NTY3ODlhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg".slice(0, 80)}`;

/** A short-term key from the Bedrock console. */
const SHORT_TERM = "bedrock-api-key-BQoJb3JpZ2luX2VjEHkaCXVzLWVhc3QtMSJHMEUCIQD";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123";

interface Row {
  readonly name: string;
  readonly input: string;
  readonly expected: ShapeProblem | undefined;
  readonly severity?: "error" | "warning";
}

const TABLE: readonly Row[] = [
  { name: "realistic long-term ABSK key", input: LONG_TERM, expected: undefined },
  { name: "short-term bedrock-api-key- key", input: SHORT_TERM, expected: undefined },
  {
    name: "leading and trailing whitespace is trimmed",
    input: `  ${LONG_TERM}\n`,
    expected: undefined,
  },
  { name: "exactly twenty characters", input: "a".repeat(20), expected: undefined },
  { name: "empty", input: "", expected: "empty", severity: "error" },
  { name: "whitespace only", input: "   \t\n", expected: "empty", severity: "error" },
  {
    name: "internal space",
    input: `${LONG_TERM.slice(0, 40)} ${LONG_TERM.slice(41)}`,
    expected: "whitespace-inside",
    severity: "error",
  },
  {
    name: "internal newline",
    input: `${LONG_TERM.slice(0, 40)}\n${LONG_TERM.slice(41)}`,
    expected: "whitespace-inside",
    severity: "error",
  },
  {
    name: "AKIA plus sixteen uppercase",
    input: ACCESS_KEY_ID,
    expected: "looks-like-access-key-id",
    severity: "error",
  },
  {
    name: "forty-character secret access key",
    input: SECRET_ACCESS_KEY.slice(0, 40),
    expected: "looks-like-secret-access-key",
    severity: "error",
  },
  {
    name: "forty base64 characters with slashes",
    input: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`,
    expected: "looks-like-secret-access-key",
    severity: "error",
  },
  { name: "eight characters", input: "abc12345", expected: "too-short", severity: "warning" },
  {
    name: "nineteen characters",
    input: "a".repeat(19),
    expected: "too-short",
    severity: "warning",
  },
];

describe("validateTokenShape", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const verdict = validateTokenShape(row.input);
      expect(verdict?.problem).toBe(row.expected);
      if (row.severity !== undefined) {
        expect(verdict?.severity).toBe(row.severity);
      }
    });
  }

  it("never rejects a short value outright, so a real short key can still be used", () => {
    // FR-4.2 risk: the format is undocumented, so length alone must not block.
    expect(validateTokenShape("short")?.severity).toBe("warning");
  });

  it("does not mistake a forty-character key with a known prefix for a secret access key", () => {
    const forty = `ABSK${"a".repeat(36)}`;
    expect(forty).toHaveLength(40);
    expect(validateTokenShape(forty)).toBeUndefined();
  });

  it("accepts AKIA-prefixed values that are not access key ids", () => {
    expect(validateTokenShape("AKIAlowercase1234567890")).toBeUndefined();
  });
});

describe("normalizeToken", () => {
  it("returns the value that should be stored", () => {
    expect(normalizeToken(`\t ${LONG_TERM} \n`)).toBe(LONG_TERM);
  });
});

describe("SHAPE_MESSAGES", () => {
  const problems: readonly ShapeProblem[] = [
    "empty",
    "whitespace-inside",
    "looks-like-access-key-id",
    "looks-like-secret-access-key",
    "too-short",
  ];

  it("covers every problem", () => {
    for (const problem of problems) {
      expect(SHAPE_MESSAGES[problem]).toBeTruthy();
    }
  });

  it("is written in plain language with no environment variable names", () => {
    // FR-5.3: the audience does not know what an environment variable is.
    for (const message of Object.values(SHAPE_MESSAGES)) {
      expect(message).not.toMatch(/AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_USE_BEDROCK|env\./);
      expect(message).not.toMatch(/[A-Z]{4,}_[A-Z]/);
    }
  });
});
