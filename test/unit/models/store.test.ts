import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileModelStore } from "../../../src/models/store.js";
import type { ModelEvidence } from "../../../src/models/types.js";

const directories: string[] = [];
const key = "a".repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "model-evidence-"));
  directories.push(directory);
  return { directory, store: new FileModelStore(directory) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const evidence: ModelEvidence = {
  modelId: "global.anthropic.claude-sonnet-5-5",
  metadataKey: "b".repeat(64),
  status: "available",
  checkedAt: 1000,
  lastAttemptAt: 1000,
  nextCheckAt: 2000,
  lastSuccessAt: 1000,
  failures: 0,
};
describe("machine-local model evidence", () => {
  it("retains the credential rejection barrier across inconclusive retries", async () => {
    const { store } = await fixture();
    const entry: ModelEvidence = {
      ...evidence,
      status: "network-error",
      lastCredentialFailureAt: 900,
    };
    await store.save(key, [entry]);
    expect(await store.load(key)).toEqual([entry]);
    await store.save(key, [{ ...entry, lastCredentialFailureAt: 1100 }]);
    expect((await store.load(key))[0]?.lastCredentialFailureAt).toBeUndefined();
  });
  it("roundtrips atomic restricted files and strips unknown values", async () => {
    const { directory, store } = await fixture();
    await store.save(key, [
      { ...evidence, reason: "secret injected in reason", token: "secret" } as ModelEvidence,
    ]);
    expect(await store.load(key)).toEqual([evidence]);
    expect(await readFile(join(directory, `${key}.json`), "utf8")).not.toContain("secret");
    // Windows reports DOS attributes here; Unix mode bits do not describe its DACL.
    if (process.platform !== "win32")
      expect((await stat(join(directory, `${key}.json`))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual([`${key}.json`]);
  });
  it("tolerates missing/corrupt/future schemas and drops malformed records", async () => {
    const { directory, store } = await fixture();
    expect(await store.load(key)).toEqual([]);
    for (const content of [
      "{",
      JSON.stringify({ version: 2, evidence: [evidence] }),
      JSON.stringify({ version: 1, evidence: [{ ...evidence, status: "injected" }] }),
    ]) {
      await writeFile(join(directory, `${key}.json`), content);
      expect(await store.load(key)).toEqual([]);
    }
  });
  it("allows one window at a time and an old release cannot remove a new lease", async () => {
    const { directory, store } = await fixture();
    const sibling = new FileModelStore(directory);
    const first = await store.acquire(key, 1000, 100);
    expect(first).toBeTypeOf("function");
    expect(await sibling.acquire(key, 1050, 100)).toBeUndefined();
    const second = await sibling.acquire(key, 1101, 100);
    expect(second).toBeTypeOf("function");
    await first?.();
    expect(await store.acquire(key, 1102, 100)).toBeUndefined();
    await second?.();
    expect(await store.acquire(key, 1103, 100)).toBeTypeOf("function");
  });
  it("handles simultaneous expiry reclamation with one winner", async () => {
    const { directory, store } = await fixture();
    await store.acquire(key, 1000, 100);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => new FileModelStore(directory).acquire(key, 1200, 100)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("recovers an expired crash between mkdir and owner write", async () => {
    const { directory, store } = await fixture();
    const path = join(directory, `${key}.lease`);
    await mkdir(path);
    await utimes(path, new Date(0), new Date(0));
    expect(await store.acquire(key, 1000, 100)).toBeTypeOf("function");
  });
  it("recovers a malformed owner marker left by a crash", async () => {
    const { directory, store } = await fixture();
    const path = join(directory, `${key}.lease`);
    await mkdir(path);
    const marker = join(path, "00000000-0000-0000-0000-000000000000");
    await writeFile(marker, "{");
    await utimes(marker, new Date(0), new Date(0));
    expect(await store.acquire(key, 1000, 100)).toBeTypeOf("function");
  });
});
