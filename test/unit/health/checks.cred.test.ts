import { describe, expect, it } from "vitest";
import type { ScanOutcome } from "../../../src/credential/leakScan.js";
import type { ConnectionResult } from "../../../src/credential/types.js";
import { credAgeCheck } from "../../../src/health/checks/cred.age.js";
import { credLeakCheck } from "../../../src/health/checks/cred.leak.js";
import { credMirroredCheck } from "../../../src/health/checks/cred.mirrored.js";
import { credPresentCheck } from "../../../src/health/checks/cred.present.js";
import { credValidCheck } from "../../../src/health/checks/cred.valid.js";
import { LABELS } from "../../../src/health/labels.js";
import type { CheckContext, CredentialContext } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { expectNoTokenLeak } from "../ui/credentialDeps.js";
import { daysAgo, FIXTURE_TOKEN, makeCtx, NOW, okCredential } from "./fixture.js";

const POLICY = BUNDLED_MANIFEST.credential;

function ctxWith(credential: Partial<CredentialContext>): CheckContext {
  return makeCtx({ credential: okCredential(credential) });
}

/** The "nothing configured" slice — the state a fresh install starts in. */
function nothing(over: Partial<CredentialContext> = {}): CheckContext {
  return makeCtx({
    credential: {
      presence: { source: "none", mismatch: false },
      policy: POLICY,
      now: NOW,
      ...over,
    },
  });
}

describe("cred.present", () => {
  it("passes when the keychain holds the key", () => {
    const result = credPresentCheck.run(
      ctxWith({ presence: { source: "keychain", mismatch: false } }),
    );
    expect(result.level).toBe("pass");
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("passes when both places hold it", () => {
    expect(credPresentCheck.run(makeCtx()).level).toBe("pass");
  });

  it("warns and offers adoption when only the settings file has one (Q-S)", () => {
    const result = credPresentCheck.run(
      ctxWith({ presence: { source: "settings-file", mismatch: false } }),
    );
    expect(result.level).toBe("warning");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.adoptToken" });
  });

  it("errors and offers the entry flow when there is no key at all", () => {
    const result = credPresentCheck.run(nothing());
    expect(result.level).toBe("error");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.setToken" });
  });

  it("reports an unreachable keychain and offers no fallback storage (Q-X)", () => {
    const result = credPresentCheck.run(
      nothing({ keychainError: "Cannot autolaunch D-Bus without X11 $DISPLAY" }),
    );
    expect(result.level).toBe("error");
    expect(result.label).toContain("keychain");
    expect(result.fix).toEqual({ kind: "none" });
    expect(result.detail).toContain("D-Bus");
  });

  it("still reports the keychain error when the file happens to hold a key", () => {
    const result = credPresentCheck.run(
      nothing({
        presence: { source: "settings-file", mismatch: false },
        keychainError: "libsecret is not installed",
      }),
    );
    expect(result.level).toBe("error");
    expect(result.fix).toEqual({ kind: "none" });
  });
});

describe("cred.mirrored", () => {
  it("passes when the file matches the keychain", () => {
    const result = credMirroredCheck.run(makeCtx());
    expect(result.level).toBe("pass");
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("skips when there is no keychain key to mirror", () => {
    expect(credMirroredCheck.run(nothing()).level).toBe("skipped");
  });

  it("skips when the key lives only in the file — cred.present owns that", () => {
    const result = credMirroredCheck.run(
      ctxWith({ presence: { source: "settings-file", mismatch: false } }),
    );
    expect(result.level).toBe("skipped");
  });

  it("errors when Claude Code cannot see the key, and offers to copy it", () => {
    const result = credMirroredCheck.run(
      ctxWith({ presence: { source: "keychain", mismatch: false } }),
    );
    expect(result.level).toBe("error");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.reapplyToken" });
  });

  it("warns rather than overwrites when the two differ (hard rule 3)", () => {
    const result = credMirroredCheck.run(ctxWith({ presence: { source: "both", mismatch: true } }));
    expect(result.level).toBe("warning");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.resolveTokenConflict" });
  });
});

describe("cred.valid", () => {
  function withResult(result: ConnectionResult) {
    return credValidCheck.run(ctxWith({ lastTest: { at: "2026-09-10T11:00:00.000Z", result } }));
  }

  it("skips until the user has run the test, and invites them to (Q-T)", () => {
    const result = credValidCheck.run(makeCtx());
    expect(result.level).toBe("skipped");
    expect(result.label).toMatch(/test it/i);
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.testConnection" });
  });

  it("passes on a successful call", () => {
    expect(withResult({ kind: "ok", model: "haiku" }).level).toBe("pass");
  });

  it("warns — not errors — when only the small model is missing (Q-U)", () => {
    const result = withResult({ kind: "ok-without-haiku", model: "sonnet" });
    expect(result.level).toBe("warning");
    expect(result.label).toMatch(/works/);
  });

  it("errors on an IAM policy denial with its own sentence, not the model one (F8)", () => {
    const result = withResult({ kind: "insufficient-permissions", status: 403 });
    expect(result.level).toBe("error");
    expect(result.label).toMatch(/permission/i);
    expect(result.label).not.toBe(LABELS["cred.valid"].modelNotEnabled);
  });

  it("says 'couldn't tell' rather than throwing on a kind it does not know (F12)", () => {
    // A future `ConnectionResult` variant must degrade to a row the user can
    // read, not an exception the runner has to catch and badge.
    const result = withResult({ kind: "not-a-real-kind" } as never);
    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["cred.valid"].unrecognised);
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.testConnection" });
  });

  it.each([
    ["bad-credential", { kind: "bad-credential", status: 403 } as const],
    ["insufficient-permissions", { kind: "insufficient-permissions", status: 403 } as const],
    ["model-not-enabled", { kind: "model-not-enabled", model: "haiku" } as const],
    ["wrong-region", { kind: "wrong-region", region: "eu-west-9" } as const],
    ["network", { kind: "network", reason: "timeout" } as const],
    ["unknown", { kind: "unknown", status: 500 } as const],
  ])("errors on %s", (_name, result) => {
    expect(withResult(result).level).toBe("error");
  });

  it("gives every outcome its own sentence", () => {
    const outcomes: ConnectionResult[] = [
      { kind: "ok", model: "haiku" },
      { kind: "ok-without-haiku", model: "sonnet" },
      { kind: "bad-credential", status: 403 },
      { kind: "insufficient-permissions", status: 403 },
      { kind: "model-not-enabled", model: "haiku" },
      { kind: "wrong-region", region: "eu-west-9" },
      { kind: "network", reason: "dns" },
      { kind: "unknown", status: 500 },
    ];
    const labels = outcomes.map((outcome) => withResult(outcome).label);
    expect(new Set(labels).size).toBe(outcomes.length);
  });

  /**
   * F5. A result recorded against one key says nothing about the key that
   * replaced it, and "Your Bedrock API key works" against a key the user has
   * since changed is the worst possible thing this check can say.
   */
  describe("a result that predates the current key", () => {
    const SET_AT = daysAgo(1);

    it("stays authoritative when the stamps match", () => {
      const result = credValidCheck.run(
        ctxWith({
          stored: { setAt: SET_AT },
          lastTest: {
            at: "2026-09-10T11:00:00.000Z",
            tokenSetAt: SET_AT,
            result: { kind: "ok", model: "haiku" },
          },
        }),
      );
      expect(result.level).toBe("pass");
    });

    it("skips rather than vouching when the key has been replaced since", () => {
      const result = credValidCheck.run(
        ctxWith({
          stored: { setAt: daysAgo(0) },
          lastTest: {
            at: "2026-09-10T11:00:00.000Z",
            tokenSetAt: daysAgo(30),
            result: { kind: "ok", model: "haiku" },
          },
        }),
      );
      expect(result.level).toBe("skipped");
      expect(result.label).toBe(LABELS["cred.valid"].untested);
      expect(result.fix).toMatchObject({ command: "sensibleDefaults.testConnection" });
    });

    it("skips a stale failure too, so a fixed key is not still accused", () => {
      const result = credValidCheck.run(
        ctxWith({
          stored: { setAt: daysAgo(0) },
          lastTest: {
            at: "2026-09-10T11:00:00.000Z",
            tokenSetAt: daysAgo(30),
            result: { kind: "bad-credential", status: 403 },
          },
        }),
      );
      expect(result.level).toBe("skipped");
    });

    it("skips when the result was recorded against a key no longer stored", () => {
      const result = credValidCheck.run(
        nothing({
          lastTest: {
            at: "2026-09-10T11:00:00.000Z",
            tokenSetAt: SET_AT,
            result: { kind: "ok", model: "haiku" },
          },
        }),
      );
      expect(result.level).toBe("skipped");
    });

    it("trusts a result from a host that does not stamp them yet", () => {
      // `tokenSetAt` is optional: an older host records without one, and the
      // check must not blank out every result waiting for a field.
      const result = credValidCheck.run(
        ctxWith({
          stored: { setAt: SET_AT },
          lastTest: { at: "2026-09-10T11:00:00.000Z", result: { kind: "ok", model: "haiku" } },
        }),
      );
      expect(result.level).toBe("pass");
    });
  });

  it("never repeats a status code or a model id at the user", () => {
    const label = withResult({ kind: "unknown", status: 500 }).label;
    expect(label).not.toMatch(/500/);
    expect(
      withResult({ kind: "model-not-enabled", model: "us.anthropic.claude-haiku" }).label,
    ).not.toContain("us.anthropic");
  });

  /**
   * Hard rule 4, on the two branches added for F8 and F12. Both render a
   * `ConnectionResult` the check has not seen before, so both are asked to
   * prove they render nothing that came from AWS or from the key.
   */
  it("renders nothing from the result on the new branches", () => {
    const leaky = [
      { kind: "insufficient-permissions", status: 403 },
      // A future variant, carrying exactly the things a body would smuggle in.
      {
        kind: "some-future-kind",
        status: 418,
        token: FIXTURE_TOKEN,
        message: `AccessDeniedException for ${FIXTURE_TOKEN} in account 123456789012`,
      },
    ] as unknown as ConnectionResult[];

    for (const result of leaky) {
      const rendered = JSON.stringify(withResult(result));
      expect(rendered).not.toContain(FIXTURE_TOKEN);
      expect(rendered).not.toContain("123456789012");
      expect(rendered).not.toContain("AccessDeniedException");
      expect(rendered).not.toMatch(/\b418\b/);
    }
  });
});

describe("cred.age", () => {
  it("skips when there is no key", () => {
    expect(credAgeCheck.run(nothing()).level).toBe("skipped");
  });

  it("passes a fresh key with nothing to do", () => {
    const result = credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(3) } }));
    expect(result.level).toBe("pass");
    expect(result.label).toContain("less than a week");
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("warns at the manifest's warn threshold and offers rotation", () => {
    const result = credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(POLICY.warnAfterDays) } }));
    expect(result.level).toBe("warning");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.rotateToken" });
  });

  it("errors at the fail threshold", () => {
    const result = credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(POLICY.failAfterDays) } }));
    expect(result.level).toBe("error");
    expect(result.label).toMatch(/time to replace/);
  });

  it("says weeks under two months and months after that, never a date", () => {
    const weeks = credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(21) } })).label;
    expect(weeks).toContain("about 3 weeks");
    const months = credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(100) } })).label;
    expect(months).toContain("about 3 months");
    for (const label of [weeks, months]) {
      expect(label).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(label).not.toMatch(/20\d\d/);
    }
  });

  it("says one week and one month in the singular", () => {
    expect(credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(8) } })).label).toContain(
      "about 1 week",
    );
    expect(credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(70) } })).label).toContain(
      "about 2 months",
    );
  });

  it("reports an unreadable stamp as information, not a failure", () => {
    const result = credAgeCheck.run(ctxWith({ stored: { setAt: "" } }));
    expect(result.level).toBe("info");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.rotateToken" });
  });

  it("treats a stamp in the future as new rather than negative", () => {
    const result = credAgeCheck.run(ctxWith({ stored: { setAt: daysAgo(-30) } }));
    expect(result.level).toBe("pass");
    expect(result.label).toContain("less than a week");
  });
});

/**
 * FR-4.8. Two things this check must never do: name the value it found, and
 * report a scan that did not finish as a clean one.
 */
describe("cred.leak", () => {
  const HIT = { file: "/home/tester/project/.env", line: 3 };

  function withScan(leakScan: ScanOutcome | undefined): CheckContext {
    return ctxWith(leakScan === undefined ? {} : { leakScan });
  }

  it("passes when the scan finished and found nothing", () => {
    const result = credLeakCheck.run(withScan({ kind: "clean" }));

    expect(result.level).toBe("pass");
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("reports 'not checked' rather than a pass when no scan was run", () => {
    const result = credLeakCheck.run(withScan(undefined));

    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["cred.leak"].notChecked);
  });

  it("skips when there is no key to look for", () => {
    const result = credLeakCheck.run(withScan({ kind: "skipped", reason: "no-token" }));

    expect(result.level).toBe("skipped");
    expect(result.label).toBe(LABELS["cred.leak"].skipped);
  });

  it("skips when no folder is open", () => {
    const result = credLeakCheck.run(withScan({ kind: "skipped", reason: "no-folders" }));

    expect(result.level).toBe("skipped");
    expect(result.label).toBe(LABELS["cred.leak"].noFolders);
  });

  /**
   * §13. Not a failure and not a pass: we were not allowed to look, and saying
   * so is what stops an untrusted folder reading as a checked one.
   */
  it("says the folder was not checked when it is untrusted", () => {
    const result = credLeakCheck.run(withScan({ kind: "skipped", reason: "untrusted" }));

    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["cred.leak"].untrusted);
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("fails on a hit and offers to open the file at the line", () => {
    const result = credLeakCheck.run(withScan({ kind: "hits", hits: [HIT] }));

    expect(result.level).toBe("error");
    expect(result.label).toBe(LABELS["cred.leak"].found);
    expect(result.fix).toEqual({
      kind: "command",
      command: "sensibleDefaults.openLeakedFile",
      title: "Open the file",
      args: [HIT.file, HIT.line],
    });
  });

  it("names the path and never the value", () => {
    const result = credLeakCheck.run(withScan({ kind: "hits", hits: [HIT] }));

    expect(result.detail).toContain(HIT.file);
    // Every string the row produces, checked against the token the fixture
    // holds — the same detector the panel-wide leak test uses.
    expectNoTokenLeak(
      [result.label, result.detail ?? "", JSON.stringify(result.fix)],
      [FIXTURE_TOKEN],
    );
  });

  /**
   * Hard rule 1 and plan Q-AD: the extension never edits a workspace file, so
   * the row must not imply that it might.
   */
  it("says plainly that nothing was changed for the user", () => {
    const result = credLeakCheck.run(withScan({ kind: "hits", hits: [HIT] }));

    expect(result.detail).toContain("Nothing here has been changed for you");
  });

  /**
   * A tracked file has almost certainly had the value committed, and no edit to
   * the working tree takes it out of history. A user who deletes the line and
   * believes they are safe is worse off than one who was never told.
   */
  it("says rotation is the only remedy when the file is tracked", () => {
    const result = credLeakCheck.run(withScan({ kind: "hits", hits: [{ ...HIT, tracked: true }] }));

    expect(result.label).toBe(LABELS["cred.leak"].foundTracked);
    expect(result.detail).toContain("history");
    expect(result.detail).toContain("replace the key");
  });

  it("gives the untracked advice when git says the file is not tracked", () => {
    const result = credLeakCheck.run(
      withScan({ kind: "hits", hits: [{ ...HIT, tracked: false }] }),
    );

    expect(result.label).toBe(LABELS["cred.leak"].found);
    expect(result.detail).not.toContain("history");
  });

  it("names every file it found, not just the one it offers to open", () => {
    const second = { file: "/home/tester/project/notes.md", line: 1 };

    const result = credLeakCheck.run(withScan({ kind: "hits", hits: [HIT, second] }));

    expect(result.detail).toContain(HIT.file);
    expect(result.detail).toContain(second.file);
  });

  it("escalates the whole row when any one hit is tracked", () => {
    const result = credLeakCheck.run(
      withScan({
        kind: "hits",
        hits: [HIT, { file: "/home/tester/project/notes.md", line: 1, tracked: true }],
      }),
    );

    expect(result.label).toBe(LABELS["cred.leak"].foundTracked);
  });

  /**
   * The rule that matters most. "We looked at some of your files and found
   * nothing" and "your key is not in your project" are different claims.
   */
  it("reports an empty partial scan as information, never a pass", () => {
    const result = credLeakCheck.run(withScan({ kind: "partial", hits: [], reason: "timeout" }));

    expect(result.level).toBe("info");
    expect(result.level).not.toBe("pass");
    expect(result.label).toBe(LABELS["cred.leak"].partial);
    expect(result.detail).toContain("not a clean result");
  });

  it("says the same for a scan stopped by the file cap", () => {
    const result = credLeakCheck.run(withScan({ kind: "partial", hits: [], reason: "file-cap" }));

    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["cred.leak"].partial);
  });

  it("still fails on a hit found before the scan ran out of budget", () => {
    const result = credLeakCheck.run(withScan({ kind: "partial", hits: [HIT], reason: "timeout" }));

    expect(result.level).toBe("error");
    expect(result.label).toBe(LABELS["cred.leak"].found);
  });

  /**
   * A `ScanOutcome` variant the check has not been taught about must not read
   * as a pass: not knowing is exactly what the "not checked" row says.
   */
  it("treats an unrecognised outcome as not checked", () => {
    const result = credLeakCheck.run(withScan({ kind: "something-new" } as unknown as ScanOutcome));

    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["cred.leak"].notChecked);
  });
});
