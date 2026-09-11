import { describe, expect, it } from "vitest";
import { LABELS } from "../../../../src/health/labels.js";
import { type CheckResult, countLevels, type HealthReport } from "../../../../src/health/types.js";
import {
  ALLOWED_ACTIONS,
  derive,
  type Inputs,
  interruptionFor,
  parseInbound,
  resultView,
} from "../../../../src/ui/panel/state.js";

function report(results: CheckResult[]): HealthReport {
  return { at: "2026-09-11T00:00:00Z", results, counts: countLevels(results) };
}

function check(
  id: CheckResult["id"],
  group: CheckResult["group"],
  level: CheckResult["level"],
  label = `${id} ${level}`,
  fix: CheckResult["fix"] = { kind: "none" },
): CheckResult {
  return { id, group, level, label, fix };
}

/** Every check passing, the extension installed, settings present. */
function healthyReport(): HealthReport {
  return report([
    check("install.extension", "Installation", "pass"),
    check("config.exists", "Configuration", "pass"),
    check("cred.present", "Credential", "pass"),
    check("cred.valid", "Credential", "pass"),
  ]);
}

const CONSOLE = "https://console.aws.amazon.com/bedrock/home#/api-keys";

function inputs(over: Partial<Inputs> = {}): Inputs {
  return {
    report: healthyReport(),
    stored: { setAt: "2026-09-08T00:00:00Z" },
    lastTestedAt: "2026-09-11T00:00:00Z",
    progress: undefined,
    consoleUrl: CONSOLE,
    detailsOpen: false,
    ...over,
  };
}

describe("derive: the three states", () => {
  it("is loading until the first report", () => {
    expect(derive(inputs({ report: undefined }))).toEqual({ kind: "loading" });
  });

  it("is unconfigured when the report says setup is needed", () => {
    const r = report([
      check("install.extension", "Installation", "pass"),
      check("config.exists", "Configuration", "error"),
    ]);
    expect(derive(inputs({ report: r })).kind).toBe("unconfigured");
  });

  it("is unconfigured when there is no stored key, even if settings exist", () => {
    // A `/setup-bedrock` user has a file but no keychain entry; the panel's
    // "Check my setup" link is how that gets adopted. Until then, not healthy.
    expect(derive(inputs({ stored: undefined })).kind).toBe("unconfigured");
  });

  it("is healthy with no interruption when everything passes", () => {
    const state = derive(inputs());
    expect(state).toMatchObject({
      kind: "healthy",
      keySetAt: "2026-09-08T00:00:00Z",
      lastTestedAt: "2026-09-11T00:00:00Z",
      interruption: undefined,
      detailsOpen: false,
    });
  });

  it("setup progress wins over everything else", () => {
    const state = derive(inputs({ progress: { step: "testing" } }));
    expect(state).toEqual({ kind: "setup", progress: { step: "testing" }, consoleUrl: CONSOLE });
  });

  it("never carries the token", () => {
    // The type forbids it; this pins the runtime shape against a future
    // `...stored` spread.
    const state = derive(
      inputs({ stored: { setAt: "2026-09-08T00:00:00Z", token: "ABSKsecret" } as never }),
    );
    expect(JSON.stringify(state)).not.toContain("ABSKsecret");
  });
});

describe("interruptionFor: priority", () => {
  const fix = {
    kind: "command",
    command: "sensibleDefaults.testConnection",
    title: "Test",
  } as const;

  it("returns nothing when there are only passes and infos", () => {
    const r = report([
      check("cred.valid", "Credential", "pass"),
      check("config.drift", "Configuration", "info", "Some settings changed"),
    ]);
    expect(interruptionFor(r)).toBeUndefined();
  });

  it("error beats warning regardless of group order", () => {
    const r = report([
      check("cred.age", "Credential", "warning", "old key"),
      check("install.cli", "Installation", "error", "no cli"),
    ]);
    expect(interruptionFor(r)?.sentence).toBe("no cli");
  });

  it("within a level, credential beats configuration beats installation", () => {
    const r = report([
      check("install.cli", "Installation", "warning", "cli"),
      check("config.region", "Configuration", "warning", "region"),
      check("cred.age", "Credential", "warning", "age"),
    ]);
    expect(interruptionFor(r)?.sentence).toBe("age");
  });

  it("plugins never interrupt", () => {
    const r = report([check("plugins.enabled", "Plugins", "error", "plugin")]);
    expect(interruptionFor(r)).toBeUndefined();
  });

  it("carries the fix as the action only if the command is allowlisted", () => {
    const allowed = report([check("cred.valid", "Credential", "error", "bad", fix)]);
    expect(interruptionFor(allowed)?.action).toEqual({
      command: "sensibleDefaults.testConnection",
      title: "Test",
    });
    const rogue = report([
      check("cred.valid", "Credential", "error", "bad", {
        kind: "command",
        command: "workbench.action.terminal.sendSequence",
        title: "x",
      }),
    ]);
    expect(interruptionFor(rogue)?.action).toBeUndefined();
  });
});

describe("resultView: one sentence, one primary, per outcome", () => {
  it("uses the cred.valid labels so the panel and the toast agree", () => {
    expect(resultView({ kind: "ok", model: "m" }).sentence).toBe(LABELS["cred.valid"].pass);
    expect(resultView({ kind: "bad-credential", status: 403 }).sentence).toBe(
      LABELS["cred.valid"].badCredential,
    );
  });

  it("only the ok outcomes finish setup", () => {
    expect(resultView({ kind: "ok", model: "m" }).primary).toMatchObject({
      message: "setup.finish",
    });
    expect(resultView({ kind: "ok-without-haiku", model: "m" }).primary).toMatchObject({
      message: "setup.finish",
    });
    expect(resultView({ kind: "bad-credential", status: 403 }).primary).toMatchObject({
      message: "setup.restart",
    });
    expect(resultView({ kind: "network", reason: "dns" }).primary).toMatchObject({
      message: "setup.retest",
    });
  });

  it("puts the status on the unknown sentence, nowhere else", () => {
    expect(resultView({ kind: "unknown", status: 502 }).sentence).toContain("HTTP 502");
    expect(resultView({ kind: "bad-credential", status: 403 }).sentence).not.toContain("403");
  });

  it("every secondary action is allowlisted", () => {
    const kinds = [
      { kind: "ok", model: "m" },
      { kind: "ok-without-haiku", model: "m" },
      { kind: "bad-credential", status: 403 },
      { kind: "insufficient-permissions", status: 403 },
      { kind: "model-not-enabled", model: "m" },
      { kind: "wrong-region", region: "r" },
      { kind: "network", reason: "dns" },
      { kind: "unknown", status: 0 },
    ] as const;
    for (const k of kinds) {
      const v = resultView(k);
      if (v.secondary) expect(ALLOWED_ACTIONS.has(v.secondary.command)).toBe(true);
      if ("command" in v.primary) expect(ALLOWED_ACTIONS.has(v.primary.command)).toBe(true);
    }
  });
});

describe("parseInbound: the page is untrusted", () => {
  it("accepts the documented shapes", () => {
    expect(parseInbound({ type: "setup.start" })).toEqual({ type: "setup.start" });
    expect(parseInbound({ type: "key.submit", value: "x" })).toEqual({
      type: "key.submit",
      value: "x",
    });
    expect(
      parseInbound({ type: "action.run", command: "sensibleDefaults.testConnection" }),
    ).toEqual({ type: "action.run", command: "sensibleDefaults.testConnection" });
  });

  it("drops anything else without throwing", () => {
    expect(parseInbound(null)).toBeUndefined();
    expect(parseInbound("setup.start")).toBeUndefined();
    expect(parseInbound({ type: "eval" })).toBeUndefined();
    expect(parseInbound({ type: "key.submit" })).toBeUndefined();
    expect(parseInbound({ type: "key.submit", value: 42 })).toBeUndefined();
  });

  it("refuses a command outside the allowlist", () => {
    expect(
      parseInbound({ type: "action.run", command: "workbench.action.terminal.sendSequence" }),
    ).toBeUndefined();
    expect(
      parseInbound({ type: "action.run", command: "sensibleDefaults.clearToken" }),
    ).toBeUndefined();
  });
});
