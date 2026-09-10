import { beforeEach, describe, expect, it } from "vitest";
import { TerminalTokenEnv } from "../../../src/credential/env.js";
import {
  BEDROCK_ENV_VAR,
  type EnvCollectionLike,
  TOKEN_ENV_VAR,
} from "../../../src/credential/types.js";

const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";

/** Records every interaction in order, so "persistent first" is testable. */
class FakeCollection implements EnvCollectionLike {
  readonly calls: string[] = [];
  #persistent = true;

  get persistent(): boolean {
    return this.#persistent;
  }

  set persistent(value: boolean) {
    this.calls.push(`persistent=${value}`);
    this.#persistent = value;
  }

  replace(variable: string, value: string): void {
    this.calls.push(`replace:${variable}=${value}`);
  }

  delete(variable: string): void {
    this.calls.push(`delete:${variable}`);
  }
}

/** A host that ignores the setter — the collection we must refuse to use. */
class StubbornCollection extends FakeCollection {
  override get persistent(): boolean {
    return true;
  }

  override set persistent(value: boolean) {
    this.calls.push(`persistent=${value}`);
  }
}

let collection: FakeCollection;

beforeEach(() => {
  collection = new FakeCollection();
});

describe("TerminalTokenEnv", () => {
  it("sets persistent false before any replace (§10.4 assertion #4)", () => {
    new TerminalTokenEnv(collection).apply(TOKEN);
    expect(collection.calls[0]).toBe("persistent=false");
    expect(collection.calls.findIndex((c) => c.startsWith("replace:"))).toBeGreaterThan(0);
    expect(collection.persistent).toBe(false);
  });

  it("applies both variables", () => {
    new TerminalTokenEnv(collection).apply(TOKEN);
    expect(collection.calls).toEqual([
      "persistent=false",
      `replace:${TOKEN_ENV_VAR}=${TOKEN}`,
      `replace:${BEDROCK_ENV_VAR}=1`,
    ]);
  });

  it("replaces rather than appending on a second apply", () => {
    const env = new TerminalTokenEnv(collection);
    env.apply(TOKEN);
    env.apply("ABSKrotated0000000000000000000000000000");
    expect(collection.calls.filter((c) => c.startsWith("replace:"))).toHaveLength(4);
    expect(collection.calls.at(-2)).toBe(
      `replace:${TOKEN_ENV_VAR}=ABSKrotated0000000000000000000000000000`,
    );
  });

  it("deletes both variables on clear", () => {
    new TerminalTokenEnv(collection).clear();
    expect(collection.calls).toEqual([
      "persistent=false",
      `delete:${TOKEN_ENV_VAR}`,
      `delete:${BEDROCK_ENV_VAR}`,
    ]);
  });

  it("throws on construction when persistent cannot be set false", () => {
    const stubborn = new StubbornCollection();
    expect(() => new TerminalTokenEnv(stubborn)).toThrow(/persistent/i);
    // Nothing was written to a collection VS Code would cache to disk.
    expect(stubborn.calls.filter((c) => c.startsWith("replace:"))).toHaveLength(0);
  });

  it("never puts the token in the construction failure message", () => {
    try {
      new TerminalTokenEnv(new StubbornCollection());
      expect.unreachable("construction should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
