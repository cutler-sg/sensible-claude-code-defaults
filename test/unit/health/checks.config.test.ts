import { describe, expect, it } from "vitest";
import { REDACTED } from "../../../src/config/managedKeys.js";
import type { Drift, ReadResult, Settings } from "../../../src/config/types.js";
import { configBedrockCheck } from "../../../src/health/checks/config.bedrock.js";
import { configDriftCheck } from "../../../src/health/checks/config.drift.js";
import { configExistsCheck } from "../../../src/health/checks/config.exists.js";
import { configModelsCheck } from "../../../src/health/checks/config.models.js";
import { configParsesCheck } from "../../../src/health/checks/config.parses.js";
import { configPermsCheck } from "../../../src/health/checks/config.perms.js";
import { configRegionCheck } from "../../../src/health/checks/config.region.js";
import { makeCtx, okRead, okSettings, SETTINGS_FILE } from "./fixture.js";

const ABSENT: ReadResult = { kind: "absent" };
const MALFORMED: ReadResult = {
  kind: "malformed",
  raw: "{,}",
  error: "settings.json is not valid JSON: Unexpected token ,",
};

function withSettings(mutate: (settings: Settings) => void) {
  const settings = okSettings();
  mutate(settings);
  return makeCtx({ read: okRead(settings) });
}

function envOf(settings: Settings): Record<string, unknown> {
  return settings.env as Record<string, unknown>;
}

describe("config.exists", () => {
  it("passes when a file is there", () => {
    expect(configExistsCheck.run(makeCtx()).level).toBe("pass");
  });

  it("passes even when the file is unreadable — config.parses owns that", () => {
    expect(configExistsCheck.run(makeCtx({ read: MALFORMED })).level).toBe("pass");
  });

  it("warns and offers apply when there is no file", () => {
    const result = configExistsCheck.run(makeCtx({ read: ABSENT }));
    expect(result.level).toBe("warning");
    expect(result.detail).toContain(SETTINGS_FILE);
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.applyDefaults" });
  });
});

describe("config.parses", () => {
  it("passes on a readable file", () => {
    expect(configParsesCheck.run(makeCtx()).level).toBe("pass");
  });

  it("skips when there is no file", () => {
    expect(configParsesCheck.run(makeCtx({ read: ABSENT })).level).toBe("skipped");
  });

  it("errors with the parser's own words and offers to open the file", () => {
    const result = configParsesCheck.run(makeCtx({ read: MALFORMED }));
    expect(result.level).toBe("error");
    expect(result.detail).toBe(MALFORMED.kind === "malformed" ? MALFORMED.error : "");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.openSettings" });
  });
});

describe("config.perms", () => {
  it("passes silently when the mode was already right", () => {
    const result = configPermsCheck.run(makeCtx());
    expect(result.level).toBe("pass");
    expect(result.detail).toBeUndefined();
  });

  it("passes with a note when the repair fixed it", () => {
    const result = configPermsCheck.run(
      makeCtx({ permissions: { kind: "repaired", before: 0o664 } }),
    );
    expect(result).toMatchObject({ level: "pass", detail: "repaired" });
  });

  it("skips when there is no file", () => {
    expect(configPermsCheck.run(makeCtx({ permissions: { kind: "absent" } })).level).toBe(
      "skipped",
    );
  });

  it("skips on Windows", () => {
    expect(configPermsCheck.run(makeCtx({ permissions: { kind: "unsupported" } })).level).toBe(
      "skipped",
    );
  });

  it("warns only when the repair itself failed", () => {
    const result = configPermsCheck.run(
      makeCtx({ permissions: { kind: "failed", error: "EPERM: operation not permitted" } }),
    );
    expect(result.level).toBe("warning");
    expect(result.detail).toContain("EPERM");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.repairPermissions" });
  });
});

describe("config.bedrock", () => {
  it.each([ABSENT, MALFORMED])("skips when there is nothing to read (%s)", (read) => {
    expect(configBedrockCheck.run(makeCtx({ read })).level).toBe("skipped");
  });

  it.each(["1", "true"])("passes on %s", (value) => {
    const ctx = withSettings((s) => {
      envOf(s).CLAUDE_CODE_USE_BEDROCK = value;
    });
    expect(configBedrockCheck.run(ctx).level).toBe("pass");
  });

  it.each([["0"], ["yes"], [undefined], [1 as unknown as string]])("errors on %s", (value) => {
    const ctx = withSettings((s) => {
      if (value === undefined) delete envOf(s).CLAUDE_CODE_USE_BEDROCK;
      else envOf(s).CLAUDE_CODE_USE_BEDROCK = value;
    });
    const result = configBedrockCheck.run(ctx);
    expect(result.level).toBe("error");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.applyDefaults" });
  });
});

describe("config.region", () => {
  it.each([ABSENT, MALFORMED])("skips when there is nothing to read (%s)", (read) => {
    expect(configRegionCheck.run(makeCtx({ read })).level).toBe("skipped");
  });

  it("passes on a known region and names it", () => {
    const result = configRegionCheck.run(makeCtx());
    expect(result.level).toBe("pass");
    expect(result.detail).toContain("us-east-1");
  });

  it.each([undefined, ""])("errors when unset (%s)", (value) => {
    const ctx = withSettings((s) => {
      if (value === undefined) delete envOf(s).AWS_REGION;
      else envOf(s).AWS_REGION = value;
    });
    const result = configRegionCheck.run(ctx);
    expect(result.level).toBe("error");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.selectRegion" });
  });

  it("errors on a region Claude Code cannot use, naming the current value", () => {
    const ctx = withSettings((s) => {
      envOf(s).AWS_REGION = "mars-north-1";
    });
    const result = configRegionCheck.run(ctx);
    expect(result.level).toBe("error");
    expect(result.detail).toContain("mars-north-1");
  });
});

describe("config.models", () => {
  it.each([ABSENT, MALFORMED])("skips when there is nothing to read (%s)", (read) => {
    expect(configModelsCheck.run(makeCtx({ read })).level).toBe("skipped");
  });

  it("passes when all three pins match", () => {
    expect(configModelsCheck.run(makeCtx()).level).toBe("pass");
  });

  it.each([
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus model"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet model"],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku model"],
  ])("warns when %s is absent", (name, display) => {
    const ctx = withSettings((s) => {
      delete envOf(s)[name];
    });
    const result = configModelsCheck.run(ctx);
    expect(result.level).toBe("warning");
    expect(result.detail).toContain(display);
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.applyDefaults" });
  });

  it("warns when a pin differs from the manifest", () => {
    const ctx = withSettings((s) => {
      envOf(s).ANTHROPIC_DEFAULT_OPUS_MODEL = "us.anthropic.claude-something-else";
    });
    expect(configModelsCheck.run(ctx).level).toBe("warning");
  });

  it("stays quiet about a drifted pin — config.drift owns it", () => {
    const settings = okSettings();
    envOf(settings).ANTHROPIC_DEFAULT_OPUS_MODEL = "us.anthropic.claude-something-else";
    const drift: Drift[] = [
      {
        key: "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
        current: "us.anthropic.claude-something-else",
        lastApplied: "us.anthropic.claude-opus-5",
        recommended: "us.anthropic.claude-opus-5",
      },
    ];
    expect(configModelsCheck.run(makeCtx({ read: okRead(settings), drift })).level).toBe("pass");
  });
});

describe("config.drift", () => {
  it("passes with no children when nothing has drifted", () => {
    const result = configDriftCheck.run(makeCtx());
    expect(result.level).toBe("pass");
    expect(result.children).toBeUndefined();
  });

  it("reports one child per drifted key with a reset command", () => {
    const drift: Drift[] = [
      {
        key: "env.AWS_REGION",
        current: "eu-central-1",
        lastApplied: "us-east-1",
        recommended: "us-east-1",
      },
      {
        key: "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
        current: "custom-haiku",
        lastApplied: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        recommended: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
    ];
    const result = configDriftCheck.run(makeCtx({ drift }));
    expect(result.level).toBe("info");
    expect(result.children).toEqual([
      {
        key: "env.AWS_REGION",
        label: "You changed the Amazon region",
        detail: "Currently eu-central-1.",
        fix: {
          kind: "command",
          command: "sensibleDefaults.resetKey",
          title: "Reset to recommended",
          args: ["env.AWS_REGION"],
        },
      },
      {
        key: "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
        label: "Claude Code changed the Haiku model",
        detail: "Currently custom-haiku.",
        fix: {
          kind: "command",
          command: "sensibleDefaults.resetKey",
          title: "Reset to recommended",
          args: ["env.ANTHROPIC_DEFAULT_HAIKU_MODEL"],
        },
      },
    ]);
  });

  it("never shows a secret's value, redacted or otherwise", () => {
    const drift: Drift[] = [
      {
        key: "env.AWS_BEARER_TOKEN_BEDROCK",
        current: "ABSKQmVkcm9ja0FQSUtleS1zZWNyZXQ=",
        lastApplied: "old-token",
        recommended: undefined,
      },
    ];
    const result = configDriftCheck.run(makeCtx({ drift }));
    const child = result.children?.[0];
    expect(child?.detail).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("ABSKQmVkcm9ja");
    expect(JSON.stringify(result)).not.toContain(REDACTED);
  });

  it("renders a non-string drifted value without crashing", () => {
    const drift: Drift[] = [
      {
        key: "permissions.deny",
        current: ["Bash(rm -rf:*)"],
        lastApplied: [],
        recommended: [],
      },
    ];
    expect(configDriftCheck.run(makeCtx({ drift })).children?.[0]?.detail).toBe(
      'Currently ["Bash(rm -rf:*)"].',
    );
  });

  it("omits the detail when the key has been removed entirely", () => {
    const drift: Drift[] = [
      {
        key: "env.AWS_REGION",
        current: undefined,
        lastApplied: "us-east-1",
        recommended: "us-east-1",
      },
    ];
    expect(configDriftCheck.run(makeCtx({ drift })).children?.[0]?.detail).toBeUndefined();
  });
});
