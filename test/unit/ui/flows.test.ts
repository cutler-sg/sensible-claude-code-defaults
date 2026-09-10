import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplySession, ConfigEnv, JsonObject, Settings } from "../../../src/config/index.js";
import { createSession, MemorySnapshotStore, settingsPath } from "../../../src/config/index.js";
import { TOKEN_ENV_VAR } from "../../../src/credential/types.js";
import { TOKEN_SETTINGS_KEY } from "../../../src/credential/writeThrough.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest } from "../../../src/manifest/types.js";
import type { FlowDeps } from "../../../src/ui/flows.js";
import * as flows from "../../../src/ui/flows.js";
import { messages, reset, state } from "./commandsHost.js";
import { bedrockOk, type FakeCredentialDeps, fakeCredentialDeps } from "./credentialDeps.js";

vi.mock("vscode", async () => await import("./commandsHost.js"));

const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";
const OTHER = "ABSKQW5vdGhlckJlZHJvY2tBUElLZXlWYWx1ZQ";
const NOW = new Date("2026-09-10T12:00:00.000Z");

let dir: string;
let env: ConfigEnv;
let session: ApplySession;
let credential: FakeCredentialDeps;
let logged: string[];
let healthRuns: number;
let writes: number;

const log = {
  info: (message: string) => logged.push(`info ${message}`),
  warn: (message: string) => logged.push(`warn ${message}`),
  error: (message: string) => logged.push(`error ${message}`),
};

function deps(manifest: Manifest = BUNDLED_MANIFEST): FlowDeps {
  return {
    env,
    session,
    manifest,
    log: log as never,
    runHealth: async () => {
      healthRuns += 1;
    },
    markWrite: () => {
      writes += 1;
    },
    credential,
    now: () => NOW,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-flows-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
  session = createSession();
  credential = fakeCredentialDeps();
  logged = [];
  healthRuns = 0;
  writes = 0;
  reset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(settings: unknown): Promise<void> {
  await writeFile(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function fileToken(): Promise<unknown> {
  const raw = await readFile(settingsPath(dir), "utf8").catch(() => "{}");
  const settings = JSON.parse(raw) as Settings;
  return (settings.env as JsonObject | undefined)?.[TOKEN_ENV_VAR];
}

/** Type the given value into the next input box. */
function type(value: string): void {
  state.inputBoxAnswer = () => value;
}

/** Answer a modal or notification by the label the user would click. */
function click(label: string): void {
  state.answer = (shown) => (shown.items.includes(label) ? label : undefined);
}

/** The `detail` of the modal the flow put in front of the user. */
function modalDetail(): string {
  return (state.warn[0]?.options as { detail?: string } | undefined)?.detail ?? "";
}

function pick(label: string): void {
  state.quickPickAnswer = (call) =>
    call.items.find((item) => (item as { label?: string }).label === label);
}

function respondWith(status: number, body = "{}"): void {
  credential.respond = () => new Response(body, { status });
}

/**
 * A snapshot store that rewrites the settings file during `load`, `times`
 * times. `plan` reads the file and *then* loads the snapshot, so this
 * reproduces exactly the window Claude Code's own `/setup-bedrock` lands in
 * between plan and commit — the race is staged rather than mocked.
 */
function racingStore(times: number): MemorySnapshotStore {
  const store = new MemorySnapshotStore();
  let left = times;
  const load = store.load.bind(store);
  store.load = async () => {
    if (left > 0) {
      left -= 1;
      // The racing writer edits the file rather than replacing it, so what is
      // already there — a token under removal, say — survives the race and the
      // assertions can be about our own behaviour rather than the fake's.
      const raw = await readFile(settingsPath(dir), "utf8").catch(() => "{}");
      const settings = JSON.parse(raw) as Settings;
      const current = (settings.env ?? {}) as JsonObject;
      await writeFile(
        settingsPath(dir),
        `${JSON.stringify({ ...settings, env: { ...current, AWS_REGION: `r${left}` } })}\n`,
        "utf8",
      );
    }
    return load();
  };
  return store;
}

describe("setToken", () => {
  it("masks the input, survives a lost focus, and links the console (FR-4.2)", async () => {
    type(TOKEN);
    await flows.setToken(deps());

    const options = state.inputBoxes[0]?.options;
    expect(options?.password).toBe(true);
    expect(options?.ignoreFocusOut).toBe(true);
    expect(options?.prompt).toContain(BUNDLED_MANIFEST.credential.consoleUrl);
    expect(options?.prompt).toContain("long-term");
    expect(options?.prompt).toMatch(/AWS recommends short-term keys/);
  });

  it("stores the key, injects it into terminals, and mirrors it into the file", async () => {
    type(TOKEN);
    await flows.setToken(deps());

    await expect(credential.store.get()).resolves.toEqual({
      token: TOKEN,
      setAt: NOW.toISOString(),
    });
    expect(credential.terminal.applied).toEqual([TOKEN]);
    expect(await fileToken()).toBe(TOKEN);
    expect(writes).toBeGreaterThan(0);
    expect(healthRuns).toBe(1);
  });

  it("trims what was pasted, so no stray newline reaches the header", async () => {
    type(`  ${TOKEN}\n`);
    await flows.setToken(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
    expect(await fileToken()).toBe(TOKEN);
  });

  it("writes nothing when the user cancels", async () => {
    await flows.setToken(deps());

    await expect(credential.store.get()).resolves.toBeUndefined();
    expect(await fileToken()).toBeUndefined();
    expect(logged).toContain("info Key entry cancelled by the user.");
    expect(healthRuns).toBe(0);
  });

  it("offers a test and runs it when accepted", async () => {
    type(TOKEN);
    click("Test connection now");
    await flows.setToken(deps());

    expect(credential.requests).toHaveLength(1);
    expect(credential.recorded[0]).toMatchObject({ kind: "ok" });
  });

  it("does not call AWS when the offer is dismissed (Q-T)", async () => {
    type(TOKEN);
    await flows.setToken(deps());

    expect(credential.requests).toEqual([]);
    expect(credential.recorded).toEqual([]);
  });
});

describe("validateInput", () => {
  it("accepts a plausible key", () => {
    expect(flows.validateInput(TOKEN)).toBeUndefined();
  });

  it("blocks an access key ID with an explanation", () => {
    expect(flows.validateInput("AKIAIOSFODNN7EXAMPLE")).toMatch(/access key ID/);
  });

  it("blocks an empty value", () => {
    expect(flows.validateInput("  ")).toMatch(/Paste your Bedrock API key/);
  });

  it("only warns about a short key, so a real one is never blocked", () => {
    const verdict = flows.validateInput("ABSKshort");
    expect(verdict).toMatchObject({ severity: 2 });
    expect((verdict as { message: string }).message).toMatch(/still use it/);
  });
});

describe("rotateToken", () => {
  it("replaces the key without ever showing the old one", async () => {
    await credential.store.set({ token: TOKEN, setAt: "2026-01-01T00:00:00.000Z" });
    await seed({ env: { [TOKEN_ENV_VAR]: TOKEN } });
    type(OTHER);

    await flows.rotateToken(deps());

    await expect(credential.store.get()).resolves.toEqual({
      token: OTHER,
      setAt: NOW.toISOString(),
    });
    expect(state.inputBoxes[0]?.options.title).toBe("Update Bedrock API Key");
    for (const shown of [...messages(), ...logged]) {
      expect(shown).not.toContain(TOKEN);
      expect(shown).not.toContain(OTHER);
    }
  });

  it("restarts the age clock, because that is all we can honestly claim", async () => {
    await credential.store.set({ token: TOKEN, setAt: "2020-01-01T00:00:00.000Z" });
    type(OTHER);

    await flows.rotateToken(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ setAt: NOW.toISOString() });
  });
});

describe("clearToken", () => {
  beforeEach(async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await seed({ env: { [TOKEN_ENV_VAR]: TOKEN, CLAUDE_CODE_USE_BEDROCK: "1" } });
  });

  it("keeps everything when the confirmation is declined", async () => {
    await flows.clearToken(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
    expect(await fileToken()).toBe(TOKEN);
    expect(logged).toContain("info Key removal cancelled by the user.");
  });

  it("confirms modally, then clears all three places", async () => {
    click("Remove key");
    await flows.clearToken(deps());

    expect(state.warn[0]?.options).toMatchObject({ modal: true });
    await expect(credential.store.get()).resolves.toBeUndefined();
    expect(credential.terminal.cleared).toBe(1);
    expect(await fileToken()).toBeUndefined();
    expect(healthRuns).toBe(1);
  });

  it("says plainly that the key still works elsewhere", async () => {
    click("Remove key");
    await flows.clearToken(deps());

    expect(modalDetail()).toMatch(/Amazon console/);
  });

  /**
   * F14. The removal takes a forced backup, which is the right thing — it is
   * the only undo for a value the user asked us to destroy — but it means a
   * plaintext copy of the key stays on this computer. A modal that says the key
   * is gone from the computer while a copy sits in `~/.claude/backups` is
   * telling the user something untrue about where their credential is.
   */
  it("says a copy is kept in the backups so the removal can be undone", async () => {
    click("Remove key");
    await flows.clearToken(deps());

    expect(modalDetail()).toMatch(/backup/i);
    expect(modalDetail()).toMatch(/undo|undone/i);
  });

  /**
   * F1. The keychain is emptied only once the file write has actually landed.
   *
   * The old order cleared the keychain and the terminals first and threw the
   * `CommitResult` away, so a lost race left the token in `settings.json`, no
   * copy anywhere we could offer back, and a toast telling the user it was
   * removed — Claude Code carrying on with the key they just deleted.
   */
  describe("when the settings file will not accept the removal", () => {
    it("leaves all three places alone when the write keeps going stale", async () => {
      env = { ...env, snapshotStore: racingStore(5) };
      click("Remove key");

      await flows.clearToken(deps());

      await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
      expect(credential.terminal.cleared).toBe(0);
      expect(await fileToken()).toBe(TOKEN);
    });

    it("says the key was not removed rather than that it was", async () => {
      env = { ...env, snapshotStore: racingStore(5) };
      click("Remove key");

      await flows.clearToken(deps());

      expect(messages()).toContainEqual(expect.stringMatching(/wasn't removed/));
      expect(messages()).not.toContainEqual(expect.stringMatching(/^Removed your Bedrock API key/));
    });

    it("keeps the saved key when the file cannot be parsed at all", async () => {
      await writeFile(settingsPath(dir), "{,}", "utf8");
      click("Remove key");

      await flows.clearToken(deps());

      // The malformed file used to throw *after* `store.clear()`, which left
      // no command able to give the key back.
      await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
      expect(credential.terminal.cleared).toBe(0);
      expect(messages()).toContainEqual(expect.stringMatching(/can't be read/));
    });
  });

  it("clears the file first, then the keychain and the terminals", async () => {
    click("Remove key");

    await flows.clearToken(deps());

    expect(await fileToken()).toBeUndefined();
    await expect(credential.store.get()).resolves.toBeUndefined();
    expect(credential.terminal.cleared).toBe(1);
    expect(messages()).toContainEqual(expect.stringMatching(/^Removed your Bedrock API key/));
  });
});

describe("adoptToken", () => {
  it("takes the key /setup-bedrock left in the file (Q-S)", async () => {
    await seed({ env: { [TOKEN_ENV_VAR]: TOKEN } });

    await flows.adoptToken(deps());

    await expect(credential.store.get()).resolves.toEqual({
      token: TOKEN,
      setAt: NOW.toISOString(),
    });
    expect(credential.terminal.applied).toEqual([TOKEN]);
    // The file keeps the same value; adoption is an ownership transfer.
    expect(await fileToken()).toBe(TOKEN);
    expect(healthRuns).toBe(1);
  });

  it("claims ownership, so the key stops reading as drift", async () => {
    await seed({ env: { [TOKEN_ENV_VAR]: TOKEN } });

    await flows.adoptToken(deps());

    const snapshot = await env.snapshotStore.load();
    expect(snapshot.values["env.AWS_BEARER_TOKEN_BEDROCK"]).toBe(TOKEN);
  });

  it("says so when there is nothing to adopt", async () => {
    await flows.adoptToken(deps());

    expect(messages()[0]).toMatch(/no Bedrock API key in your settings file/);
    await expect(credential.store.get()).resolves.toBeUndefined();
  });

  /**
   * F10. `enterToken` trims precisely so no stray newline reaches the
   * `Authorization` header; a value that arrives from the file has had no such
   * treatment, and `/setup-bedrock` or a hand-edit can leave one there.
   */
  it("trims the file's value before it reaches the keychain or a terminal", async () => {
    await seed({ env: { [TOKEN_ENV_VAR]: `  ${TOKEN}\n` } });

    await flows.adoptToken(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
    expect(credential.terminal.applied).toEqual([TOKEN]);
    expect(await fileToken()).toBe(TOKEN);
  });

  /**
   * F6. `adoptToken` is a palette command as well as a health fix, so it can be
   * run with a different key already saved — and it wrote the file's value
   * straight over it, unrecoverably, with nothing asked. Two keys and only the
   * user knows which is current: that is `resolveTokenConflict`'s question, and
   * it already asks it.
   */
  describe("when a different key is already saved", () => {
    beforeEach(async () => {
      await credential.store.set({ token: OTHER, setAt: "2026-01-01T00:00:00.000Z" });
      await seed({ env: { [TOKEN_ENV_VAR]: TOKEN } });
    });

    it("asks instead of overwriting the saved key", async () => {
      await flows.adoptToken(deps());

      expect(state.quickPicks).toHaveLength(1);
      await expect(credential.store.get()).resolves.toMatchObject({ token: OTHER });
    });

    it("adopts the file's key when the user chooses it", async () => {
      pick("Use the key in my settings file");

      await flows.adoptToken(deps());

      await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
      expect(await fileToken()).toBe(TOKEN);
    });

    it("does not ask when the saved key is the same one", async () => {
      await credential.store.set({ token: TOKEN, setAt: "2026-01-01T00:00:00.000Z" });

      await flows.adoptToken(deps());

      expect(state.quickPicks).toEqual([]);
      await expect(credential.store.get()).resolves.toMatchObject({ setAt: NOW.toISOString() });
    });
  });
});

/**
 * F4. `takeOwnership` threw its `CommitResult` away, so a lost race with
 * whatever else writes this file left both its callers silent: `adoptToken`
 * said the key was saved to the keychain when the file still held another, and
 * `resolveTokenConflict` — the command whose entire job is to settle that
 * disagreement — showed nothing at all.
 */
describe("an ownership transfer that loses the race", () => {
  const KEPT_CHANGING = /kept changing/;

  beforeEach(async () => {
    await seed({ env: { [TOKEN_ENV_VAR]: TOKEN } });
  });

  /**
   * Only the direction that changes bytes can lose the race. Adopting the
   * file's own value plans no change at all, so `commit` returns `noop` before
   * it ever compares the file — which is why `adoptTokenFromSettings` persists
   * the ownership claim itself for that case.
   */
  it("retries once and succeeds, like every other write here", async () => {
    await credential.store.set({ token: OTHER, setAt: "2026-01-01T00:00:00.000Z" });
    env = { ...env, snapshotStore: racingStore(1) };
    pick("Use the key I saved");

    await flows.resolveTokenConflict(deps());

    expect(logged).toContainEqual(expect.stringMatching(/retrying once/));
    expect(await fileToken()).toBe(OTHER);
    const snapshot = await env.snapshotStore.load();
    expect(snapshot.values[TOKEN_SETTINGS_KEY]).toBe(OTHER);
  });

  it("does not report an adoption the file never accepted", async () => {
    await credential.store.set({ token: OTHER, setAt: "2026-01-01T00:00:00.000Z" });
    env = { ...env, snapshotStore: racingStore(5) };
    pick("Use the key I saved");

    await flows.resolveTokenConflict(deps());

    expect(await fileToken()).toBe(TOKEN);
    expect(healthRuns).toBe(0);
  });

  it("warns when the conflict resolver cannot write its answer", async () => {
    await credential.store.set({ token: OTHER, setAt: "2026-01-01T00:00:00.000Z" });
    env = { ...env, snapshotStore: racingStore(5) };
    pick("Use the key I saved");

    await flows.resolveTokenConflict(deps());

    expect(messages()).toContainEqual(expect.stringMatching(KEPT_CHANGING));
  });

  it("trims a file-sourced key the conflict resolver adopts (F10)", async () => {
    await credential.store.set({ token: OTHER, setAt: "2026-01-01T00:00:00.000Z" });
    await seed({ env: { [TOKEN_ENV_VAR]: `${TOKEN}\n` } });
    pick("Use the key in my settings file");

    await flows.resolveTokenConflict(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
    expect(credential.terminal.applied).toEqual([TOKEN]);
    expect(await fileToken()).toBe(TOKEN);
  });
});

/**
 * F2 and F3. A mirror that did not happen is never announced as one.
 *
 * `merge` preserves a value at the token key that we did not write (hard rule
 * 3, correctly), so a commit can report `written: true` for the
 * `CLAUDE_CODE_USE_BEDROCK` half while the token itself was never mirrored —
 * and the flows said "Claude Code can now see your Bedrock API key" anyway.
 * `reapplyToken` was the worst of it: `cred.mirrored` routes to it whenever the
 * file's token reads as absent, which includes an empty string, so the user got
 * a fix button that claimed success, changed nothing, and reappeared on the
 * next health run for ever.
 */
describe("a settings file whose token key holds something else", () => {
  const SUCCESS = /Claude Code can now see your Bedrock API key/;
  const BLOCKED = /wasn't copied into your settings file/;

  /** The action offered alongside the "not mirrored" warning. */
  const TAKE_OVER = "Use the key I saved";

  it.each([
    ["a rival key", OTHER],
    // The value that made `reapplyToken` a permanent no-op: the file's token
    // reads as absent, so `cred.mirrored` keeps nominating the fix.
    ["an empty string", ""],
  ])("does not claim setToken mirrored the key over %s", async (_name, existing) => {
    await seed({ env: { [TOKEN_ENV_VAR]: existing } });
    type(TOKEN);

    await flows.setToken(deps());

    expect(await fileToken()).toBe(existing);
    expect(messages()).not.toContainEqual(expect.stringMatching(SUCCESS));
    expect(messages()).toContainEqual(expect.stringMatching(BLOCKED));
  });

  it("does not claim reapplyToken mirrored the key", async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await seed({ env: { [TOKEN_ENV_VAR]: "", CLAUDE_CODE_USE_BEDROCK: "1" } });

    await flows.reapplyToken(deps());

    expect(messages()).not.toContainEqual(expect.stringMatching(SUCCESS));
    expect(messages()).toContainEqual(expect.stringMatching(BLOCKED));
  });

  /**
   * The point of the whole finding: the fix button has to be able to finish.
   * Health says "Claude Code can't see your key", the user clicks the fix, and
   * the next health run must not say the same thing again.
   */
  it("terminates the health → fix → health loop when the user takes the key over", async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await seed({ env: { [TOKEN_ENV_VAR]: "", CLAUDE_CODE_USE_BEDROCK: "1" } });
    click(TAKE_OVER);

    await flows.reapplyToken(deps());

    expect(await fileToken()).toBe(TOKEN);

    // A second click has nothing left to complain about, which is what
    // "terminates" means: the same fix, run again, no longer reports a
    // conflict — so the health run behind it stops re-offering it.
    reset();
    await flows.reapplyToken(deps());

    expect(await fileToken()).toBe(TOKEN);
    expect(messages()).not.toContainEqual(expect.stringMatching(BLOCKED));
    expect(messages()).toContainEqual(expect.stringMatching(SUCCESS));
  });

  it("changes nothing when the user does not take the key over", async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await seed({ env: { [TOKEN_ENV_VAR]: OTHER } });

    await flows.reapplyToken(deps());

    expect(await fileToken()).toBe(OTHER);
  });

  it("names neither key in the warning or its action (hard rule 4)", async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await seed({ env: { [TOKEN_ENV_VAR]: OTHER } });

    await flows.reapplyToken(deps());

    for (const shown of [...state.warn, ...state.info, ...state.error]) {
      expect(JSON.stringify(shown)).not.toContain(TOKEN);
      expect(JSON.stringify(shown)).not.toContain(OTHER);
    }
  });
});

describe("reapplyToken", () => {
  it("copies the saved key into the file so the panel can see it", async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });

    await flows.reapplyToken(deps());

    expect(await fileToken()).toBe(TOKEN);
    expect(credential.terminal.applied).toEqual([TOKEN]);
    expect(healthRuns).toBe(1);
  });

  it("says so when there is no saved key", async () => {
    await flows.reapplyToken(deps());

    expect(messages()[0]).toMatch(/no saved Bedrock API key/);
    expect(await fileToken()).toBeUndefined();
  });
});

describe("resolveTokenConflict", () => {
  beforeEach(async () => {
    await credential.store.set({ token: TOKEN, setAt: "2026-01-01T00:00:00.000Z" });
    await seed({ env: { [TOKEN_ENV_VAR]: OTHER } });
  });

  it("offers the two by where they came from, never by their value", async () => {
    await flows.resolveTokenConflict(deps());

    const labels = (state.quickPicks[0]?.items ?? []).map(
      (item) =>
        `${(item as { label: string }).label} ${(item as { description: string }).description}`,
    );
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label).not.toContain(TOKEN);
      expect(label).not.toContain(OTHER);
    }
  });

  it("keeps the file's key when the user picks it", async () => {
    pick("Use the key in my settings file");

    await flows.resolveTokenConflict(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: OTHER });
    expect(await fileToken()).toBe(OTHER);
    expect(healthRuns).toBe(1);
  });

  it("overwrites the file when the user picks the saved key", async () => {
    pick("Use the key I saved");

    await flows.resolveTokenConflict(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
    expect(await fileToken()).toBe(TOKEN);
  });

  it("changes nothing when the user cancels", async () => {
    await flows.resolveTokenConflict(deps());

    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
    expect(await fileToken()).toBe(OTHER);
    expect(logged).toContain("info Key conflict left unresolved by the user.");
  });

  it("says so when the conflict resolved itself in the meantime", async () => {
    await credential.store.clear();

    await flows.resolveTokenConflict(deps());

    expect(messages()[0]).toMatch(/no longer a conflict/);
    expect(healthRuns).toBe(1);
  });
});

describe("testConnection", () => {
  beforeEach(async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
  });

  it("shows progress and sends the key exactly once, as a bearer token", async () => {
    await seed({ env: { AWS_REGION: "eu-central-1" } });

    await flows.testConnection(deps());

    expect(state.progressTitles[0]).toMatch(/Testing your Bedrock API key/);
    expect(credential.requests).toHaveLength(1);
    expect(credential.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(credential.requests[0]?.url).toContain("bedrock-runtime.eu-central-1.amazonaws.com");
  });

  it("tries Haiku first and Sonnet second (Q-U)", async () => {
    const haiku = BUNDLED_MANIFEST.defaults.env.ANTHROPIC_DEFAULT_HAIKU_MODEL as string;
    const sonnet = BUNDLED_MANIFEST.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL as string;
    credential.respond = (url) =>
      url.includes(encodeURIComponent(haiku))
        ? new Response('{"message":"AccessDeniedException: model not enabled"}', { status: 403 })
        : bedrockOk();

    await flows.testConnection(deps());

    expect(credential.requests.map((r) => r.url)).toEqual([
      expect.stringContaining(encodeURIComponent(haiku)),
      expect.stringContaining(encodeURIComponent(sonnet)),
    ]);
    expect(credential.recorded[0]).toMatchObject({ kind: "ok-without-haiku" });
    expect(state.warn[0]?.message).toMatch(/small, fast Claude model/);
  });

  it("falls back to the recommended region when none is configured", async () => {
    await flows.testConnection(deps());

    expect(credential.requests[0]?.url).toContain(
      `bedrock-runtime.${BUNDLED_MANIFEST.defaults.env.AWS_REGION}.amazonaws.com`,
    );
  });

  it("uses the recommended region when the settings file cannot be read", async () => {
    await writeFile(settingsPath(dir), "{,}", "utf8");

    await flows.testConnection(deps());

    expect(credential.requests[0]?.url).toContain(
      `bedrock-runtime.${BUNDLED_MANIFEST.defaults.env.AWS_REGION}.amazonaws.com`,
    );
  });

  it("records the result for cred.valid and reruns the checks", async () => {
    await flows.testConnection(deps());

    expect(credential.recorded).toEqual([{ kind: "ok", model: expect.any(String) }]);
    expect(healthRuns).toBe(1);
  });

  it("reports a refused key without echoing the key or the status", async () => {
    respondWith(403, '{"message":"UnrecognizedClientException: security token is invalid"}');

    await flows.testConnection(deps());

    expect(credential.recorded[0]).toMatchObject({ kind: "bad-credential" });
    expect(state.error[0]?.message).toMatch(/wouldn't accept/);
    expect(state.error[0]?.message).not.toContain("403");
    expect(state.error[0]?.message).not.toContain(TOKEN);
  });

  it.each([
    ["wrong region", 404, "{}", /region/],
    ["a proxy in the way", 407, "", /Couldn't reach Amazon/],
    ["an answer we don't understand", 500, "{}", /didn't understand/],
  ])("reports %s", async (_name, status, body, expected) => {
    respondWith(status, body);

    await flows.testConnection(deps());

    expect(state.error[0]?.message).toMatch(expected);
  });

  it("reports a model that is not turned on", async () => {
    respondWith(403, '{"message":"AccessDeniedException for this model"}');

    await flows.testConnection(deps());

    expect(credential.recorded[0]).toMatchObject({ kind: "model-not-enabled" });
    expect(state.error[0]?.message).toMatch(/aren't turned on/);
  });

  it("says so when there is no key to test", async () => {
    await credential.store.clear();

    await flows.testConnection(deps());

    expect(messages()[0]).toMatch(/no Bedrock API key to test/);
    expect(credential.requests).toEqual([]);
  });

  it("logs only the outcome, never the key or the response body", async () => {
    respondWith(403, `{"message":"denied for ${TOKEN}"}`);

    await flows.testConnection(deps());

    for (const line of logged) expect(line).not.toContain(TOKEN);
    expect(logged).toContain("info Connection test: bad-credential");
  });

  it("survives a manifest with no model pins rather than calling AWS blind", async () => {
    const manifest: Manifest = {
      ...BUNDLED_MANIFEST,
      defaults: { ...BUNDLED_MANIFEST.defaults, env: { AWS_REGION: "us-east-1" } },
    };

    await flows.testConnection(deps(manifest));

    expect(credential.requests).toEqual([]);
    expect(credential.recorded[0]).toMatchObject({ kind: "unknown" });
  });
});

/**
 * Claude Code's own `/setup-bedrock` writes this file too, so a commit can lose
 * the race between plan and commit. The answer is to re-plan against what is
 * there now, never to force our document over theirs.
 *
 * The race is staged rather than mocked: `plan` reads the file, then loads the
 * snapshot, so a snapshot store that touches the file during `load` reproduces
 * exactly the window the real writer lands in.
 */
describe("a settings file that changes under the write", () => {
  it("re-plans once and succeeds", async () => {
    await seed({ env: {} });
    env = { ...env, snapshotStore: racingStore(1) };
    type(TOKEN);

    await flows.setToken(deps());

    expect(logged).toContain(
      "warn The settings file changed while writing the key; retrying once.",
    );
    expect(await fileToken()).toBe(TOKEN);
  });

  it("gives up after one retry rather than forcing its document over theirs", async () => {
    await seed({ env: {} });
    env = { ...env, snapshotStore: racingStore(5) };
    type(TOKEN);

    await flows.setToken(deps());

    expect(await fileToken()).toBeUndefined();
    expect(messages()).toContainEqual(expect.stringMatching(/kept changing/));
    // The keychain still has it: the canonical copy is written first and the
    // file is a derived artefact, so `cred.mirrored` has a one-click fix.
    await expect(credential.store.get()).resolves.toMatchObject({ token: TOKEN });
  });
});

/**
 * Hard rule 4, end to end: a known token is seeded into the keychain, the
 * settings file, and a test result, and every string these flows produce is
 * searched for it. This is the test that would catch a well-meaning "show the
 * last four characters so they can tell them apart" change.
 */
describe("the token never reaches a user-visible string", () => {
  it("stays out of every message, log line and pick label", async () => {
    await credential.store.set({ token: TOKEN, setAt: NOW.toISOString() });
    await seed({ env: { [TOKEN_ENV_VAR]: OTHER } });
    respondWith(403, `{"message":"denied for ${TOKEN}"}`);

    type(TOKEN);
    click("Test connection now");
    pick("Use the key I saved");
    await flows.setToken(deps());
    await flows.rotateToken(deps());
    await flows.resolveTokenConflict(deps());
    await flows.reapplyToken(deps());
    await flows.adoptToken(deps());
    await flows.testConnection(deps());
    click("Remove key");
    await flows.clearToken(deps());

    const rendered = [
      ...messages(),
      ...logged,
      ...state.progressTitles,
      ...state.inputBoxes.map((call) => JSON.stringify(call.options)),
      ...state.quickPicks.map((call) => JSON.stringify(call.items)),
      ...[...state.info, ...state.warn, ...state.error].map((shown) =>
        JSON.stringify(shown.options ?? {}),
      ),
    ];
    // The flows did run — otherwise this asserts over an empty list.
    expect(rendered.length).toBeGreaterThan(20);
    for (const text of rendered) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(OTHER);
    }
  });
});
