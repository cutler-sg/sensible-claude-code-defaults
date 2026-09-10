import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySnapshotStore, settingsPath } from "../../../src/config/index.js";
import type { ConfigEnv } from "../../../src/config/types.js";
import { MemoryTokenStore } from "../../../src/credential/store.js";
import { readTokenFromSettings } from "../../../src/credential/writeThrough.js";
import { ALL_CHECKS } from "../../../src/health/catalogue.js";
import { buildContext } from "../../../src/health/context.js";
import { runAll } from "../../../src/health/runner.js";
import type { ClaudeCodeDetection } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { HealthTreeProvider, type Node } from "../../../src/ui/treeProvider.js";
import { expectNoTokenLeak, MIN_LEAK_RUN } from "./credentialDeps.js";
import * as stub from "./vscodeStub.js";

vi.mock("vscode", async () => await import("./vscodeStub.js"));

/**
 * Hard rule 4, over the whole health path at once.
 *
 * A known token is put everywhere a token can be — the keychain, the settings
 * file, the last test result — and then every string the panel produces from a
 * real run is searched for it: labels, details, tooltips, accessibility text,
 * and the tree item ids.
 *
 * A whole-value `not.toContain` is not enough: the reviewer inserted
 * `` `…${token.slice(-4)}` `` into a toast and every assertion here still
 * passed (F11). So the search is for any contiguous *run* of a token rather
 * than for the token, and a partial disclosure fails as loudly as the whole
 * thing. The complementary test for the command surface lives in
 * `flows.test.ts`, over the same detector.
 */
const TOKEN = "ABSKTGVha1Rlc3RCZWRyb2NrQVBJS2V5VmFsdWU";
/** A different value in the file, so the mismatch branches render too. */
const FILE_TOKEN = "ABSKRmlsZUxlYWtUZXN0QmVkcm9ja0tleVZhbHVl";
const SECRETS = [TOKEN, FILE_TOKEN];

const DETECTED: ClaudeCodeDetection = {
  extension: { installed: true, version: "2.1.267" },
  cli: { found: true, version: "2.1.267" },
};

let dir: string;
let env: ConfigEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-redaction-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * `TreeItem`'s label and tooltip are each a string or a small object
 * (`TreeItemLabel`, `MarkdownString`). Both carry text a user reads, so both
 * are flattened rather than narrowed away — narrowing to `string` would let a
 * leak hide in the variant the test skipped.
 */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Every string the tree would put in front of a user, plus the ids behind it. */
function rendered(provider: HealthTreeProvider): string[] {
  const out: string[] = [];
  const walk = (node?: Node): void => {
    for (const child of provider.getChildren(node)) {
      const item = provider.getTreeItem(child);
      out.push(textOf(item.label), item.id ?? "", textOf(item.tooltip), item.contextValue ?? "");
      out.push(item.accessibilityInformation?.label ?? "");
      walk(child);
    }
  };
  walk();
  return out;
}

/**
 * The detector is only worth what it catches, so it is tested on the exact
 * mutation that slipped past the assertions it replaces.
 */
describe("the leak detector itself", () => {
  it("catches the last four characters, which a whole-value match misses", () => {
    const toast = `Saved your key ending in …${TOKEN.slice(-4)}`;

    expect(toast).not.toContain(TOKEN);
    expect(() => expectNoTokenLeak([toast], SECRETS)).toThrow(/reached a rendered string/);
  });

  it("names no part of the token when it fails", () => {
    const attempt = (): void => {
      expectNoTokenLeak([`leaked ${TOKEN.slice(0, 12)}`], SECRETS);
    };

    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN.slice(0, MIN_LEAK_RUN));
    }
  });

  it("passes a string that merely shares a shorter fragment with the token", () => {
    const nearMiss = `Your key ${TOKEN.slice(0, MIN_LEAK_RUN - 1)} is saved`;
    expect(() => expectNoTokenLeak([nearMiss], SECRETS)).not.toThrow();
  });
});

describe("a token that exists in every place at once", () => {
  it("appears in no label, detail, tooltip or id the panel produces", async () => {
    await writeFile(
      settingsPath(dir),
      `${JSON.stringify({ env: { AWS_BEARER_TOKEN_BEDROCK: FILE_TOKEN } }, null, 2)}\n`,
      "utf8",
    );

    const ctx = await buildContext({
      env,
      manifest: BUNDLED_MANIFEST,
      platform: process.platform,
      detect: async () => DETECTED,
      credential: {
        store: new MemoryTokenStore({ token: TOKEN, setAt: "2025-01-01T00:00:00.000Z" }),
        readFromSettings: () => readTokenFromSettings(env),
        // A result carrying a model id, so the "did we echo the input back"
        // path is exercised as well.
        lastTest: {
          at: "2026-09-10T11:00:00.000Z",
          result: { kind: "model-not-enabled", model: "us.anthropic.claude-haiku-4-5" },
        },
      },
    });

    // The states under test are actually reached: both places hold a key, and
    // they differ, so `cred.present`, `cred.mirrored` and `cred.age` all render
    // a populated branch rather than a skip.
    expect(ctx.credential.presence).toMatchObject({ source: "both", mismatch: true });

    const report = await runAll(ALL_CHECKS, ctx);
    const provider = new HealthTreeProvider();
    provider.setReport(report);

    const strings = [
      ...report.results.flatMap((result) => [
        result.id,
        result.label,
        result.detail ?? "",
        JSON.stringify(result.fix),
        ...(result.children ?? []).flatMap((child) => [
          child.label,
          child.detail ?? "",
          JSON.stringify(child.fix),
        ]),
      ]),
      ...rendered(provider),
      JSON.stringify(ctx.credential),
    ];

    // Guards the assertion itself: an empty or tiny list would pass vacuously.
    expect(strings.length).toBeGreaterThan(60);
    expectNoTokenLeak(strings, SECRETS);
  });

  it("renders the drift row for the key without its value", async () => {
    await writeFile(
      settingsPath(dir),
      `${JSON.stringify({ env: { AWS_BEARER_TOKEN_BEDROCK: FILE_TOKEN } }, null, 2)}\n`,
      "utf8",
    );

    const built = await buildContext({
      env,
      manifest: BUNDLED_MANIFEST,
      platform: process.platform,
      detect: async () => DETECTED,
    });
    // The manifest carries no recommended token, so `merge` never visits the
    // key and cannot produce this entry on its own — but M4's manifest can add
    // one, and the drift row must be safe before it does.
    const ctx: typeof built = {
      ...built,
      drift: [
        {
          key: "env.AWS_BEARER_TOKEN_BEDROCK",
          current: FILE_TOKEN,
          lastApplied: TOKEN,
          recommended: TOKEN,
        },
      ],
    };
    const report = await runAll(ALL_CHECKS, ctx);
    const provider = new HealthTreeProvider();
    provider.setReport(report);

    // The row exists — otherwise this asserts over a tree that never rendered
    // the key at all, which would pass for the wrong reason.
    const drift = report.results.find((result) => result.id === "config.drift");
    expect(drift?.children?.map((child) => child.key)).toContain("env.AWS_BEARER_TOKEN_BEDROCK");
    const row = rendered(provider).find((text) => text.includes("Amazon Bedrock API key"));
    expect(row).toBeDefined();

    expectNoTokenLeak(rendered(provider), SECRETS);
    expect(stub.TreeItemCollapsibleState.Expanded).toBe(2);
  });
});
