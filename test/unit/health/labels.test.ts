import { describe, expect, it } from "vitest";
import { MANAGED_KEYS } from "../../../src/config/types.js";
import { driftLabel, keyDisplayName, LABELS } from "../../../src/health/labels.js";

/** Anything shaped like an env var name: two or more caps, an underscore, more caps. */
const ENV_VAR_SHAPE = /[A-Z]{2,}_[A-Z_]+/;

function everyLabel(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const [id, value] of Object.entries(LABELS)) {
    if (typeof value === "string") {
      out.push({ path: id, text: value });
      continue;
    }
    for (const [situation, text] of Object.entries(value)) {
      out.push({ path: `${id}.${situation}`, text });
    }
  }
  for (const key of MANAGED_KEYS) {
    out.push({ path: `keyDisplayName(${key})`, text: keyDisplayName(key) });
    out.push({ path: `driftLabel(${key})`, text: driftLabel(key) });
  }
  return out;
}

describe("labels", () => {
  const labels = everyLabel();

  it("covers every managed key and every check id", () => {
    expect(labels.length).toBeGreaterThan(40);
  });

  it.each(labels)("$path speaks plainly", ({ text }) => {
    expect(text).not.toMatch(ENV_VAR_SHAPE);
    expect(text).not.toMatch(/JSON/);
    expect(text).not.toMatch(/settings\.json/);
  });

  it("blames Claude Code for the model pins and the user for everything else", () => {
    expect(driftLabel("env.ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe(
      "Claude Code changed the Opus model",
    );
    expect(driftLabel("env.ANTHROPIC_DEFAULT_SONNET_MODEL")).toBe(
      "Claude Code changed the Sonnet model",
    );
    expect(driftLabel("env.ANTHROPIC_DEFAULT_HAIKU_MODEL")).toBe(
      "Claude Code changed the Haiku model",
    );
    expect(driftLabel("env.AWS_REGION")).toBe("You changed the Amazon region");
    expect(driftLabel("permissions.deny")).toBe("You changed the blocked commands list");
  });

  it("names keys in words a non-technical user recognises", () => {
    expect(keyDisplayName("env.AWS_REGION")).toBe("Amazon region");
    expect(keyDisplayName("permissions.deny")).toBe("blocked commands list");
    expect(keyDisplayName("enabledPlugins")).toBe("enabled plugins list");
  });
});
