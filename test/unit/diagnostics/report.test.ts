import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySnapshotStore, settingsPath } from "../../../src/config/index.js";
import type { ConfigEnv } from "../../../src/config/types.js";
import { MemoryTokenStore } from "../../../src/credential/store.js";
import { readTokenFromSettings } from "../../../src/credential/writeThrough.js";
import {
  buildDiagnostics,
  DIAGNOSTICS_EXCLUDES,
  DIAGNOSTICS_INCLUDES,
  type DiagnosticsDeps,
} from "../../../src/diagnostics/report.js";
import { ALL_CHECKS } from "../../../src/health/catalogue.js";
import { buildContext } from "../../../src/health/context.js";
import { runAll } from "../../../src/health/runner.js";
import type { ClaudeCodeDetection, HealthReport } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { Logger } from "../../../src/util/log.js";
import { forgetAll, REDACTED } from "../../../src/util/redact.js";
import { expectNoTokenLeak } from "../ui/credentialDeps.js";

/**
 * The token seeded into every place a token can be. A recognisable literal so
 * the assertions below can hunt for it — and, deliberately, one that matches
 * `redact.ts`'s `ABSK` pattern *and* is registered by the store, because the
 * report has to survive either net failing on its own (see the two tests that
 * disarm each in turn).
 */
const TOKEN = "ABSKRGlhZ25vc3RpY3NMZWFrVGVzdEtleVZhbHVl";

/** A second value that no pattern recognises: only the registry can catch it. */
const UNPATTERNED = "Zq7Xk2Mv9Tb4Rn6Wc8Jd3Fp5Hs1Ly0Gu";

const DETECTED: ClaudeCodeDetection = {
  extension: { installed: true, version: "2.1.267" },
  cli: { found: true, version: "2.1.267" },
};

const NOW = new Date("2026-09-11T09:00:00.000Z");

/** Enough of a `LogOutputChannel` for `Logger` to write into. */
const NULL_CHANNEL = { info: () => {}, warn: () => {}, error: () => {} } as never;

let dir: string;
let env: ConfigEnv;

beforeEach(async () => {
  forgetAll();
  dir = await mkdtemp(join(tmpdir(), "scd-diag-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
});

afterEach(async () => {
  forgetAll();
  await rm(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    extensionVersion: "0.1.0",
    vscodeVersion: "1.98.2",
    platform: "linux",
    arch: "x64",
    claudeCodeExtensionVersion: "2.1.267",
    claudeCliVersion: "2.1.267",
    manifest: { revision: BUNDLED_MANIFEST.revision, source: "bundled" },
    settings: { kind: "absent" },
    log: new Logger(NULL_CHANNEL),
    now: NOW,
    settingsPath: settingsPath(dir),
    ...overrides,
  };
}

/**
 * §10.4 assertion #1, end to end.
 *
 * A known token is put in the keychain, in the settings file, in an
 * output-channel line and in a check detail, a real health run is made over
 * them, and the resulting report is searched for the token — byte-for-byte, and
 * then for any contiguous four-character run of it, which is the detector that
 * caught `` `…${token.slice(-4)}` `` in M3 (F11).
 *
 * The mutation that proves this test can fail is recorded in the M5 report: a
 * `` `key ends …${token.slice(-4)}` `` line appended to `environment()` made
 * both the whole-value and the fragment assertion fail; restoring it made them
 * pass again.
 */
describe("§10.4 #1 — a known token appears nowhere in the diagnostics", () => {
  async function seedEverything(): Promise<{ text: string; report: HealthReport }> {
    await writeFile(
      settingsPath(dir),
      `${JSON.stringify(
        {
          env: { AWS_BEARER_TOKEN_BEDROCK: TOKEN, AWS_REGION: "us-east-1" },
          // A second copy under a key we do not manage, so the key rule cannot
          // reach it and the registry has to.
          notes: `my key is ${TOKEN}`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx = await buildContext({
      env,
      manifest: BUNDLED_MANIFEST,
      platform: "linux",
      detect: async () => DETECTED,
      credential: {
        store: new MemoryTokenStore({ token: TOKEN, setAt: "2026-01-01T00:00:00.000Z" }),
        readFromSettings: () => readTokenFromSettings(env),
      },
    });
    // A check detail carrying the token: `detail` is the one `CheckResult` field
    // that holds text this extension did not write — a parse error, an OS
    // keychain failure — so it is the realistic disclosure path.
    const report = await runAll(ALL_CHECKS, {
      ...ctx,
      credential: { ...ctx.credential, keychainError: `libsecret refused: ${TOKEN}` },
    });

    const log = new Logger(NULL_CHANNEL);
    log.info(`Applied the key ${TOKEN} to new terminals.`);
    log.error(`Failed with Authorization: Bearer ${TOKEN}`);

    const settings = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(settingsPath(dir), "utf8")),
    ) as unknown;

    return {
      text: buildDiagnostics(
        deps({ settings: { kind: "ok", data: settings }, report, log, arch: "x64" }),
      ),
      report,
    };
  }

  it("is a report substantial enough for the assertion to mean something", async () => {
    const { text, report } = await seedEverything();

    // A vacuous pass is the failure mode here: an empty report contains no
    // token either. So the shape is asserted before the absence is.
    expect(text.length).toBeGreaterThan(1500);
    expect(text).toContain("### Your Claude Code settings");
    expect(text).toContain("### Health checks");
    expect(text).toContain("### Output log");
    expect(text).toContain("us-east-1");
    expect(report.results.length).toBeGreaterThan(15);
    // The seeded places actually rendered: the settings block, a check detail,
    // and two log lines are all in there, redacted.
    expect(text).toContain("cred.present");
    expect(text.match(/«redacted»/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("contains the token nowhere, byte-for-byte", async () => {
    const { text } = await seedEverything();

    expect(text).not.toContain(TOKEN);
  });

  it("contains no contiguous four-character run of the token", async () => {
    const { text } = await seedEverything();

    expectNoTokenLeak([text], [TOKEN]);
  });

  /**
   * The registry alone, with the pattern net unable to help: `UNPATTERNED`
   * matches none of `redact.ts`'s patterns, so a report that scrubs it can only
   * have done so because the store registered it.
   */
  it("scrubs a token no pattern recognises", async () => {
    await writeFile(
      settingsPath(dir),
      `${JSON.stringify({ env: { AWS_BEARER_TOKEN_BEDROCK: UNPATTERNED }, notes: UNPATTERNED })}\n`,
      "utf8",
    );
    // The read is what registers it, exactly as a health run would.
    await readTokenFromSettings(env);
    const log = new Logger(NULL_CHANNEL);
    log.info(`saved ${UNPATTERNED}`);

    const text = buildDiagnostics(
      deps({
        settings: {
          kind: "ok",
          data: { env: { AWS_BEARER_TOKEN_BEDROCK: UNPATTERNED }, notes: UNPATTERNED },
        },
        log,
      }),
    );

    expect(text).not.toContain(UNPATTERNED);
    expectNoTokenLeak([text], [UNPATTERNED]);
  });

  /**
   * The key rule alone, with the registry empty: a value the extension has
   * never held, in the managed key, on a machine where the user pasted it by
   * hand. This is the half that does not depend on knowing the key format.
   */
  it("scrubs the managed key by name with an empty registry", () => {
    forgetAll();
    const neverSeen = "Pw4Nb8Kt2Vx6Lm0Cq5Ry9Df3Jh7Sz1Ae";

    const text = buildDiagnostics(
      deps({ settings: { kind: "ok", data: { env: { AWS_BEARER_TOKEN_BEDROCK: neverSeen } } } }),
    );

    expect(text).not.toContain(neverSeen);
    expect(text).toContain(`"AWS_BEARER_TOKEN_BEDROCK": "${REDACTED}"`);
  });
});

describe("the report's shape", () => {
  it("names the extension, VS Code, the platform and the arch", () => {
    const text = buildDiagnostics(deps({ platform: "darwin", arch: "arm64" }));

    expect(text).toContain("| Extension | 0.1.0 |");
    expect(text).toContain("| VS Code | 1.98.2 |");
    expect(text).toContain("| Platform | darwin arm64 |");
  });

  it("says 'local' rather than leaving the remote cell blank", () => {
    expect(buildDiagnostics(deps())).toContain("| Remote | local |");
  });

  it("names the remote when there is one", () => {
    expect(buildDiagnostics(deps({ remoteName: "wsl" }))).toContain("| Remote | wsl |");
  });

  it("says plainly when Claude Code is not installed or not on PATH", () => {
    // Absent, not explicitly undefined: `exactOptionalPropertyTypes` treats
    // those as different, and the report's fallbacks are about absence.
    const {
      claudeCodeExtensionVersion: _extension,
      claudeCliVersion: _cli,
      ...withoutClaudeCode
    } = deps();
    const text = buildDiagnostics(withoutClaudeCode);

    expect(text).toContain("| Claude Code extension | not installed |");
    expect(text).toContain("| Claude Code CLI | not found |");
  });

  it("reports the manifest revision, source and fetch time", () => {
    const text = buildDiagnostics(
      deps({
        manifest: { revision: "2026-09-01", source: "fetched", fetchedAt: "2026-09-11T08:00:00Z" },
      }),
    );

    expect(text).toContain("| Revision | 2026-09-01 |");
    expect(text).toContain("| Source | fetched |");
    expect(text).toContain("| Fetched | 2026-09-11T08:00:00Z |");
  });

  it("says a bundled manifest was never fetched, rather than showing a blank", () => {
    expect(buildDiagnostics(deps())).toContain("never (using the copy in the extension)");
  });

  it("reports the FR-3.5 gate when a newer manifest wants a newer extension", () => {
    const text = buildDiagnostics(
      deps({
        manifest: { revision: "r1", source: "cached", needsExtensionVersion: "0.2.0" },
      }),
    );

    expect(text).toContain("| Newer manifest needs extension | 0.2.0 |");
  });

  it("says there is no settings file rather than showing an empty block", () => {
    expect(buildDiagnostics(deps())).toContain("There is no settings file yet.");
  });

  /**
   * A file that did not parse has no keys, so the key rule cannot apply and
   * `redact` is the only thing between the raw text and a public issue.
   */
  it("shows a malformed settings file as-is, scrubbed", () => {
    const text = buildDiagnostics(
      deps({
        settings: {
          kind: "malformed",
          raw: `{ "env": { "AWS_BEARER_TOKEN_BEDROCK": "${TOKEN}" },`,
        },
      }),
    );

    expect(text).toContain("could not be read as JSON");
    expect(text).not.toContain(TOKEN);
  });

  it("says the health checks have not run yet rather than showing an empty table", () => {
    expect(buildDiagnostics(deps())).toContain("have not finished a run yet");
  });

  it("says nothing has been logged rather than showing an empty block", () => {
    expect(buildDiagnostics(deps())).toContain("Nothing has been logged in this window yet.");
  });

  it("renders the last log lines with their levels", () => {
    const log = new Logger(NULL_CHANNEL);
    log.info("first");
    log.warn("second");
    log.error("third");

    const text = buildDiagnostics(deps({ log }));

    expect(text).toContain("[info] first");
    expect(text).toContain("[warn] second");
    expect(text).toContain("[error] third");
  });

  it("renders the health results as a table with a count summary", () => {
    const report: HealthReport = {
      at: "2026-09-11T08:59:00.000Z",
      results: [
        {
          id: "cred.present",
          group: "Credential",
          level: "error",
          label: "No Bedrock API key is saved",
          fix: { kind: "none" },
        },
        {
          id: "install.cli",
          group: "Installation",
          level: "pass",
          label: "You can also start Claude Code from a terminal",
          detail: "claude 2.1.267",
          fix: { kind: "none" },
        },
      ],
      counts: { pass: 1, info: 0, warning: 0, error: 1, skipped: 0 },
    };

    const text = buildDiagnostics(deps({ report }));

    expect(text).toContain("| Check | Result | What it said |");
    expect(text).toContain("| cred.present | error | No Bedrock API key is saved |");
    expect(text).toContain("claude 2.1.267");
    expect(text).toContain("1 pass, 1 error");
  });

  /**
   * A pipe ends a table cell and a newline ends the row, so either turns the
   * rest of the report into garbage — and both arrive routinely, from a Windows
   * path or a multi-line parse error.
   */
  it("escapes pipes and flattens newlines in a table cell", () => {
    const report: HealthReport = {
      at: "2026-09-11T08:59:00.000Z",
      results: [
        {
          id: "config.parses",
          group: "Configuration",
          level: "error",
          label: "Your settings are damaged",
          detail: "line 3 | column 5\nunexpected token",
          fix: { kind: "none" },
        },
      ],
      counts: { pass: 0, info: 0, warning: 0, error: 1, skipped: 0 },
    };

    const text = buildDiagnostics(deps({ report }));
    const row = text.split("\n").find((line) => line.includes("config.parses"));

    expect(row).toBeDefined();
    // Escaped once, not twice: a doubly-escaped pipe renders as a stray
    // backslash in the cell.
    expect(row).toContain("line 3 \\| column 5 unexpected token");
    expect(row).not.toContain("\\\\|");
    // The whole detail stayed on one row rather than breaking the table.
    expect(row?.endsWith(" |")).toBe(true);
    expect(text.split("\n").filter((line) => line.includes("unexpected token"))).toHaveLength(1);
  });

  /**
   * A settings file or a log line containing a fence would otherwise close the
   * block early and spill the rest of the report into the surrounding Markdown
   * — where a GitHub issue would render it as prose and, worse, where anything
   * after it stops being visibly part of the quoted block.
   */
  it("uses a fence longer than any backtick run inside the block", () => {
    const log = new Logger(NULL_CHANNEL);
    log.info("a line with ``` inside it");

    const text = buildDiagnostics(deps({ log }));

    expect(text).toContain("````\n[info] a line with ``` inside it\n````");
  });

  it("stamps the report with the time it was produced", () => {
    expect(buildDiagnostics(deps())).toContain("Generated 2026-09-11T09:00:00.000Z");
  });

  it("ends by saying the key was removed", () => {
    expect(buildDiagnostics(deps())).toContain("The Bedrock API key is replaced");
  });

  it("names the settings file so a remote window is unambiguous", () => {
    expect(buildDiagnostics(deps())).toContain(settingsPath(dir));
  });
});

describe("what the confirmation promises", () => {
  it("lists something for each section the report actually has", () => {
    expect(DIAGNOSTICS_INCLUDES.length).toBeGreaterThanOrEqual(5);
    expect(DIAGNOSTICS_EXCLUDES).toContain("Bedrock API key");
  });
});
