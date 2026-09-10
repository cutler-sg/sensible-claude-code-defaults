import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMementoSnapshotStore,
  FileSnapshotStore,
  MEMENTO_SNAPSHOT_KEY,
  MemorySnapshotStore,
  type SnapshotMemento,
} from "../../src/config/snapshot.js";
import type { Snapshot } from "../../src/config/types.js";

const POSIX = process.platform !== "win32";

const SAMPLE: Snapshot = {
  schemaVersion: 1,
  manifestRevision: "2026-09-10",
  appliedAt: "2026-09-10T11:22:33.000Z",
  values: {
    "env.AWS_REGION": "us-east-1",
    "env.AWS_BEARER_TOKEN_BEDROCK": "shh",
    "permissions.deny": ["Bash(rm -rf:*)"],
    enabledPlugins: { "example@marketplace": true },
  },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-snapshot-"));
});

afterEach(async () => {
  // A test may leave the directory unwritable; restore before cleanup.
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

/** Names of quarantined snapshots sitting beside `state.json`. */
async function corruptSiblings(inDir: string): Promise<string[]> {
  const entries = await readdir(inDir);
  return entries.filter((name) => name.includes(".corrupt-"));
}

describe("FileSnapshotStore.load", () => {
  it("returns an empty snapshot when the file does not exist", async () => {
    const store = new FileSnapshotStore(join(dir, "missing", "state.json"));

    await expect(store.load()).resolves.toEqual({ schemaVersion: 1, values: {} });
  });

  it("returns a fresh values object on every load", async () => {
    const store = new FileSnapshotStore(join(dir, "state.json"));

    const first = await store.load();
    first.values["env.AWS_REGION"] = "eu-west-1";
    const second = await store.load();

    expect(second.values).toEqual({});
  });

  it("propagates read errors that are not ENOENT", async () => {
    const asDirectory = join(dir, "state.json");
    await mkdir(asDirectory);
    const store = new FileSnapshotStore(asDirectory);

    await expect(store.load()).rejects.toThrow(/EISDIR/);
  });

  it("keeps keys that are no longer managed rather than dropping them (F13)", async () => {
    const file = join(dir, "state.json");
    const values = { "env.AWS_REGION": "us-east-1", "env.RETIRED_KEY": "we-wrote-this" };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, values }));
    const store = new FileSnapshotStore(file);

    const loaded = await store.load();

    expect(loaded.values).toEqual(values);
    expect(await corruptSiblings(dir)).toEqual([]);
  });

  it("survives a load/save round trip without forgetting a de-managed key (F13)", async () => {
    const file = join(dir, "state.json");
    const values = { "env.AWS_REGION": "us-east-1", "env.RETIRED_KEY": "we-wrote-this" };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, values }));
    const store = new FileSnapshotStore(file);

    await store.save(await store.load());

    expect(JSON.parse(await readFile(file, "utf8")).values).toEqual(values);
  });

  it("quarantines a snapshot holding a value JSON cannot represent (F17)", async () => {
    const file = join(dir, "state.json");
    // Not reachable through `JSON.parse`, but a Memento or a future in-process
    // caller can hand `parseSnapshot` anything; the file store exercises the
    // same validator through its own quarantine path.
    await writeFile(file, JSON.stringify({ schemaVersion: 1, values: { bad: undefined } }));
    await writeFile(file, '{"schemaVersion":1,"values":{"env.AWS_REGION":"ok"},"extra":1}');

    await expect(new FileSnapshotStore(file).load()).resolves.toMatchObject({
      values: { "env.AWS_REGION": "ok" },
    });
  });

  it("ignores metadata fields of the wrong type", async () => {
    const file = join(dir, "state.json");
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, manifestRevision: 7, appliedAt: false, values: {} }),
    );

    const loaded = await new FileSnapshotStore(file).load();

    expect(loaded).toEqual({ schemaVersion: 1, values: {} });
  });

  it.each([
    ["unparseable JSON", "{ not json"],
    ["a future schema version", JSON.stringify({ schemaVersion: 2, values: {} })],
    ["a non-object values field", JSON.stringify({ schemaVersion: 1, values: [] })],
    ["a JSON array at the root", "[]"],
    ["a JSON scalar at the root", '"nope"'],
  ])("quarantines %s and returns empty", async (_label, contents) => {
    const file = join(dir, "state.json");
    await writeFile(file, contents);
    const store = new FileSnapshotStore(file);

    await expect(store.load()).resolves.toEqual({ schemaVersion: 1, values: {} });

    const siblings = await corruptSiblings(dir);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatch(/^state\.json\.corrupt-/);
    await expect(readFile(join(dir, siblings[0] as string), "utf8")).resolves.toBe(contents);
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it.runIf(POSIX)("still returns empty when the bad file cannot be moved aside", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, "{ not json");
    await chmod(dir, 0o500);
    const store = new FileSnapshotStore(file);

    await expect(store.load()).resolves.toEqual({ schemaVersion: 1, values: {} });
  });
});

describe("FileSnapshotStore.save", () => {
  it("round-trips a snapshot through the file system", async () => {
    const store = new FileSnapshotStore(join(dir, "state.json"));

    await store.save(SAMPLE);

    await expect(store.load()).resolves.toEqual(SAMPLE);
  });

  it("creates the parent directory and leaves no temp files behind", async () => {
    const nested = join(dir, "sensible-defaults", "nested");
    const store = new FileSnapshotStore(join(nested, "state.json"));

    await store.save(SAMPLE);

    const written = await readFile(join(nested, "state.json"), "utf8");
    expect(written).toBe(`${JSON.stringify(SAMPLE, null, 2)}\n`);
    expect(await readdir(nested)).toEqual(["state.json"]);
  });

  it.runIf(POSIX)("writes the snapshot with mode 0600 (it holds the bearer token)", async () => {
    const file = join(dir, "state.json");
    const store = new FileSnapshotStore(file);

    await store.save(SAMPLE);

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it.runIf(POSIX)("removes the temp file and rethrows when the write fails", async () => {
    const file = join(dir, "state.json");
    const store = new FileSnapshotStore(file);
    await chmod(dir, 0o500);

    await expect(store.save(SAMPLE)).rejects.toThrow(/EACCES/);

    await chmod(dir, 0o700);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("MemorySnapshotStore", () => {
  it("defaults to an empty snapshot", async () => {
    await expect(new MemorySnapshotStore().load()).resolves.toEqual({
      schemaVersion: 1,
      values: {},
    });
  });

  it("isolates the stored snapshot from both the saver and the loader", async () => {
    const store = new MemorySnapshotStore();
    const saved: Snapshot = { schemaVersion: 1, values: { "env.AWS_REGION": "us-east-1" } };

    await store.save(saved);
    saved.values["env.AWS_REGION"] = "mutated-after-save";
    const first = await store.load();
    first.values["env.AWS_REGION"] = "mutated-after-load";

    await expect(store.load()).resolves.toEqual({
      schemaVersion: 1,
      values: { "env.AWS_REGION": "us-east-1" },
    });
  });

  it("clones the snapshot it is seeded with", async () => {
    const initial: Snapshot = { schemaVersion: 1, values: { "env.AWS_REGION": "us-east-1" } };
    const store = new MemorySnapshotStore(initial);

    initial.values["env.AWS_REGION"] = "mutated";

    await expect(store.load()).resolves.toEqual({
      schemaVersion: 1,
      values: { "env.AWS_REGION": "us-east-1" },
    });
  });
});

/** Minimal stand-in for `vscode.Memento`. */
function fakeMemento(seed: Record<string, unknown> = {}): SnapshotMemento & {
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = { ...seed };
  return {
    store,
    get<T>(key: string): T | undefined {
      return store[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      store[key] = value;
    },
  };
}

describe("createMementoSnapshotStore", () => {
  it("round-trips through the default key", async () => {
    const memento = fakeMemento();
    const store = createMementoSnapshotStore(memento);

    await store.save(SAMPLE);

    expect(memento.store[MEMENTO_SNAPSHOT_KEY]).toEqual(SAMPLE);
    await expect(store.load()).resolves.toEqual(SAMPLE);
  });

  it("honours a caller-supplied key", async () => {
    const memento = fakeMemento();
    const store = createMementoSnapshotStore(memento, "custom.key");

    await store.save(SAMPLE);

    expect(memento.store["custom.key"]).toEqual(SAMPLE);
    expect(memento.store[MEMENTO_SNAPSHOT_KEY]).toBeUndefined();
  });

  it("returns empty for an absent or badly shaped value", async () => {
    const empty = { schemaVersion: 1, values: {} };

    await expect(createMementoSnapshotStore(fakeMemento()).load()).resolves.toEqual(empty);
    await expect(
      createMementoSnapshotStore(fakeMemento({ [MEMENTO_SNAPSHOT_KEY]: "junk" })).load(),
    ).resolves.toEqual(empty);
    await expect(
      createMementoSnapshotStore(
        fakeMemento({ [MEMENTO_SNAPSHOT_KEY]: { schemaVersion: 2, values: {} } }),
      ).load(),
    ).resolves.toEqual(empty);
  });

  it("keeps unmanaged keys on load (F13)", async () => {
    const values = { "env.AWS_REGION": "us-east-1", "legacy.key": 1 };
    const memento = fakeMemento({
      [MEMENTO_SNAPSHOT_KEY]: { schemaVersion: 1, values },
    });

    const loaded = await createMementoSnapshotStore(memento).load();

    expect(loaded.values).toEqual(values);
  });

  it("returns empty for a value that is not JSON-representable (F17)", async () => {
    const memento = fakeMemento({
      [MEMENTO_SNAPSHOT_KEY]: {
        schemaVersion: 1,
        values: { "env.AWS_REGION": () => "not json" },
      },
    });

    await expect(createMementoSnapshotStore(memento).load()).resolves.toEqual({
      schemaVersion: 1,
      values: {},
    });
  });

  it.each([
    ["a null", null],
    ["a nested array of primitives", [1, "a", true, null]],
    ["a nested object", { a: { b: [1] } }],
    ["a negative number", -1.5],
  ])("accepts %s value (F17)", async (_label, value) => {
    const memento = fakeMemento({
      [MEMENTO_SNAPSHOT_KEY]: { schemaVersion: 1, values: { "env.AWS_REGION": value } },
    });

    await expect(createMementoSnapshotStore(memento).load()).resolves.toEqual({
      schemaVersion: 1,
      values: { "env.AWS_REGION": value },
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["a Date", new Date()],
    ["a Map", new Map()],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["an array holding a function", [() => 1]],
  ])("rejects a snapshot whose value is %s (F17)", async (_label, value) => {
    const memento = fakeMemento({
      [MEMENTO_SNAPSHOT_KEY]: { schemaVersion: 1, values: { "env.AWS_REGION": value } },
    });

    await expect(createMementoSnapshotStore(memento).load()).resolves.toEqual({
      schemaVersion: 1,
      values: {},
    });
  });

  it("returns empty for a value holding a cyclic object (F17)", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const memento = fakeMemento({
      [MEMENTO_SNAPSHOT_KEY]: { schemaVersion: 1, values: { "env.AWS_REGION": cyclic } },
    });

    await expect(createMementoSnapshotStore(memento).load()).resolves.toEqual({
      schemaVersion: 1,
      values: {},
    });
  });
});

describe("FileSnapshotStore honours the workspace guard (F14)", () => {
  it("refuses to save a snapshot inside a workspace folder", async () => {
    const workspace = join(dir, "proj");
    await mkdir(workspace, { recursive: true });
    const store = new FileSnapshotStore(join(workspace, "state.json"), {
      workspaceFolders: [workspace],
    });

    await expect(store.save(SAMPLE)).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await readdir(workspace)).toEqual([]);
  });

  it("refuses when only a symlink on the way points into a workspace", async () => {
    const workspace = join(dir, "proj");
    await mkdir(workspace, { recursive: true });
    const link = join(dir, "state-dir");
    await symlink(workspace, link);
    const store = new FileSnapshotStore(join(link, "state.json"), {
      workspaceFolders: [workspace],
    });

    await expect(store.save(SAMPLE)).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await readdir(workspace)).toEqual([]);
  });

  it("refuses to quarantine a corrupt snapshot into a workspace folder", async () => {
    const workspace = join(dir, "proj");
    await mkdir(workspace, { recursive: true });
    const file = join(workspace, "state.json");
    await writeFile(file, "{ not json");
    const store = new FileSnapshotStore(file, { workspaceFolders: [workspace] });

    // A load must still succeed: the snapshot is advisory, and refusing to
    // rename inside a workspace is not a reason to fail the health check.
    await expect(store.load()).resolves.toEqual({ schemaVersion: 1, values: {} });
    expect(await readdir(workspace)).toEqual(["state.json"]);
  });

  it("defaults to no workspace folders so existing callers keep working", async () => {
    const store = new FileSnapshotStore(join(dir, "state.json"));

    await store.save(SAMPLE);

    await expect(store.load()).resolves.toEqual(SAMPLE);
  });

  it("uses the injected platform for the guard's path flavour", async () => {
    const store = new FileSnapshotStore("C:\\proj\\state.json", {
      workspaceFolders: ["c:\\PROJ"],
      platform: "win32",
    });

    await expect(store.save(SAMPLE)).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
  });
});
