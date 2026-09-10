import { describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { SchemaProblem } from "../../../src/manifest/schema.js";
import { selectNotices, validateManifest } from "../../../src/manifest/schema.js";
import type { Manifest, ManifestNotice } from "../../../src/manifest/types.js";

type Json = Record<string, unknown>;

/** The known-good document every case below deviates from by one field. */
const VALID: Json = {
  schemaVersion: 1,
  revision: "2026-09-10T00:00:00Z",
  minExtensionVersion: "0.1.0",
  minimumClaudeCodeVersion: "2.1.0",
  defaults: {
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5",
    },
    permissions: { deny: ["Bash(rm -rf:*)", "Read(./.env)"] },
    extraKnownMarketplaces: {
      "acme-tools": { source: { source: "github", repo: "acme/tools" } },
    },
    enabledPlugins: { "linter@acme-tools": true },
  },
  regions: ["us-east-1", "eu-central-1"],
  credential: {
    warnAfterDays: 90,
    failAfterDays: 180,
    consoleUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
  },
  notices: [],
};

/** Every field the schema demands and nothing more. */
const MINIMAL: Json = {
  schemaVersion: 1,
  revision: "r1",
  minExtensionVersion: "0",
  minimumClaudeCodeVersion: "2",
  defaults: {
    env: {},
    permissions: { deny: [] },
    extraKnownMarketplaces: {},
    enabledPlugins: {},
  },
  regions: ["us-east-1"],
  credential: { warnAfterDays: 7, failAfterDays: 8, consoleUrl: "https://example.com/keys" },
};

function manifestWith(overrides: Json): Json {
  return { ...structuredClone(VALID), ...overrides };
}

function defaultsWith(overrides: Json): Json {
  const defaults = structuredClone(VALID.defaults) as Json;
  return manifestWith({ defaults: { ...defaults, ...overrides } });
}

function marketplace(source: unknown): Json {
  return defaultsWith({ extraKnownMarketplaces: { "acme-tools": { source } } });
}

function notices(...entries: unknown[]): Json {
  return manifestWith({ notices: entries });
}

function accept(input: unknown): Manifest {
  const result = validateManifest(input);
  if (!result.ok) throw new Error(`expected acceptance, got ${JSON.stringify(result.problems)}`);
  return result.manifest;
}

function refuse(input: unknown): SchemaProblem[] {
  const result = validateManifest(input);
  if (result.ok) throw new Error("expected refusal, got a valid manifest");
  return result.problems;
}

/** Only `JSON.parse` yields a real own `__proto__` key; an object literal sets the prototype. */
function parsed(json: string): Json {
  return JSON.parse(json) as Json;
}

describe("validateManifest", () => {
  describe("acceptance", () => {
    it("accepts the manifest shipped in the VSIX", () => {
      expect(accept(BUNDLED_MANIFEST)).toEqual(BUNDLED_MANIFEST);
    });

    it("accepts a document carrying only the fields the schema demands", () => {
      expect(accept(MINIMAL)).toEqual({ ...MINIMAL, notices: [] });
    });

    it("returns a value the input document can no longer reach", () => {
      const input = structuredClone(VALID);
      const manifest = accept(input);
      const defaults = input.defaults as {
        env: Record<string, string>;
        permissions: { deny: string[] };
        extraKnownMarketplaces: Json;
      };

      defaults.env.AWS_REGION = "eu-west-1";
      defaults.permissions.deny.push("Read(./anything)");
      defaults.extraKnownMarketplaces["evil-tools"] = {
        source: { source: "github", repo: "evil/tools" },
      };
      (input.regions as string[]).push("xx-fake-1");
      (input.credential as Json).failAfterDays = 1;

      expect(manifest.defaults.env.AWS_REGION).toBe("us-east-1");
      expect(manifest.defaults.permissions.deny).toEqual(["Bash(rm -rf:*)", "Read(./.env)"]);
      expect(Object.keys(manifest.defaults.extraKnownMarketplaces)).toEqual(["acme-tools"]);
      expect(manifest.regions).toEqual(["us-east-1", "eu-central-1"]);
      expect(manifest.credential.failAfterDays).toBe(180);
    });
  });

  describe("the document itself", () => {
    it.each([
      ["an array", []],
      ["null", null],
      ["a string", "{}"],
      ["a number", 1],
      ["undefined", undefined],
    ])("refuses %s at the top level", (_name, input) => {
      expect(refuse(input)).toEqual([{ path: "", problem: "not a JSON object" }]);
    });

    it.each([
      ["absent", undefined],
      ["0", 0],
      ["a future version", 2],
      ['the string "1"', "1"],
      ["null", null],
    ])("refuses schemaVersion %s without inspecting the rest", (_name, schemaVersion) => {
      expect(refuse(manifestWith({ schemaVersion, regions: [] }))).toEqual([
        { path: "schemaVersion", problem: "must be 1" },
      ]);
    });

    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["a number", 3],
      ["null", null],
    ])("refuses a revision that is %s", (_name, revision) => {
      expect(refuse(manifestWith({ revision }))).toContainEqual({
        path: "revision",
        problem: "must be a non-empty string",
      });
    });

    it.each([
      ["a bare major", "3"],
      ["a major.minor", "0.2"],
      ["a full triple", "1.10.4"],
      ["a pre-release suffix", "2.0.0-beta.3"],
    ])("accepts %s as a version", (_name, version) => {
      const manifest = accept(
        manifestWith({ minExtensionVersion: version, minimumClaudeCodeVersion: version }),
      );
      expect(manifest.minExtensionVersion).toBe(version);
      expect(manifest.minimumClaudeCodeVersion).toBe(version);
    });

    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["a v prefix", "v1.2.3"],
      ["four segments", "1.2.3.4"],
      ["an empty segment", "1..2"],
      ["a number", 1.2],
      ["an array", ["1.2.3"]],
    ])("refuses a minExtensionVersion that is %s", (_name, minExtensionVersion) => {
      expect(refuse(manifestWith({ minExtensionVersion }))).toContainEqual({
        path: "minExtensionVersion",
        problem: "must be a dotted version",
      });
    });

    it("refuses a minimumClaudeCodeVersion in the wrong shape", () => {
      expect(refuse(manifestWith({ minimumClaudeCodeVersion: "latest" }))).toContainEqual({
        path: "minimumClaudeCodeVersion",
        problem: "must be a dotted version",
      });
    });

    it("reports every bad top-level field in one pass", () => {
      const problems = refuse(
        manifestWith({ revision: "", minExtensionVersion: 1, minimumClaudeCodeVersion: null }),
      );
      expect(problems.map((problem) => problem.path)).toEqual([
        "revision",
        "minExtensionVersion",
        "minimumClaudeCodeVersion",
      ]);
    });

    it("refuses a defaults block that is not an object", () => {
      expect(refuse(manifestWith({ defaults: ["env"] }))).toEqual([
        { path: "defaults", problem: "must be an object" },
      ]);
    });
  });

  describe("defaults.env", () => {
    it("keeps the Bedrock keys it knows and drops everything else", () => {
      const manifest = accept(
        defaultsWith({ env: { AWS_REGION: "eu-central-1", SOME_FUTURE_KEY: "on" } }),
      );
      expect(manifest.defaults.env).toEqual({ AWS_REGION: "eu-central-1" });
    });

    // The forward-compatibility rule: a newer manifest adding a structured value
    // under a key this build has never heard of must not pin it to its cache.
    it("drops an unknown key holding a value no version of this build could use", () => {
      const manifest = accept(
        defaultsWith({
          env: { AWS_REGION: "us-west-2", FUTURE_POLICY: { mode: "strict", retries: 3 } },
        }),
      );
      expect(manifest.defaults.env).toEqual({ AWS_REGION: "us-west-2" });
    });

    it.each([
      ["a boolean", true],
      ["a number", 1],
      ["null", null],
      ["an array", ["us-east-1"]],
      ["an object", { region: "us-east-1" }],
    ])("refuses a known key holding %s", (_name, value) => {
      expect(refuse(defaultsWith({ env: { AWS_REGION: value } }))).toEqual([
        { path: "defaults.env.AWS_REGION", problem: "must be a string" },
      ]);
    });

    // Was "accepts an empty string, which is how a manifest unsets a variable".
    // It never was: `merge` removes a key when the desired value is `undefined`,
    // so an empty string is written through as an empty string, and every one of
    // the five keys is unusable empty — `AWS_REGION: ""` builds the hostname
    // `bedrock-runtime..amazonaws.com`.
    it.each([
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_REGION",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ])("refuses an empty %s", (key) => {
      expect(refuse(defaultsWith({ env: { [key]: "" } }))).toHaveLength(1);
    });

    it.each([
      ["an array", []],
      ["null", null],
      ["a string", "AWS_REGION=us-east-1"],
      ["absent", undefined],
    ])("refuses an env block that is %s", (_name, env) => {
      expect(refuse(defaultsWith({ env }))).toContainEqual({
        path: "defaults.env",
        problem: "must be an object",
      });
    });
  });

  /**
   * F1. The whitelist above says *which* keys the manifest may set; these say
   * what it may set them to. Without them the channel controls the content of
   * five environment variables verbatim, and `AWS_REGION` is interpolated by
   * Claude Code into `bedrock-runtime.<region>.amazonaws.com` — so a region is
   * a hostname fragment, and an unvalidated one is the user's Bedrock bearer
   * token delivered to whoever the manifest names, on every request.
   */
  describe("defaults.env values", () => {
    function envValue(key: string, value: unknown): Json {
      return defaultsWith({ env: { [key]: value } });
    }

    it.each(["us-east-1", "us-gov-west-1", "ap-southeast-2", "eu-central-1"])(
      "accepts the region %s",
      (region) => {
        expect(accept(envValue("AWS_REGION", region)).defaults.env.AWS_REGION).toBe(region);
      },
    );

    // The exact value the reviewer built: it validates as a string, is written
    // into settings.json, and Claude Code resolves
    // `bedrock-runtime.us-east-1.attacker.test:443/v1#.amazonaws.com` — a host
    // the attacker owns, with the fragment swallowing our suffix.
    it("refuses a region carrying a host, a port and a fragment", () => {
      expect(refuse(envValue("AWS_REGION", "us-east-1.attacker.test:443/v1#"))).toEqual([
        { path: "defaults.env.AWS_REGION", problem: "must be an AWS region name" },
      ]);
    });

    it.each([
      ["uppercase", "US-EAST-1"],
      ["an availability zone", "us-east-1a"],
      ["a trailing dot", "us-east-1."],
      ["a leading separator", "-us-east-1"],
      ["credentials in a userinfo prefix", "user@evil.test/us-east-1"],
      ["a newline and a second value", "us-east-1\nAWS_REGION=evil"],
      ["a wildcard", "us-*-1"],
      ["whitespace around a good region", " us-east-1 "],
    ])("refuses a region that is %s", (_name, region) => {
      expect(refuse(envValue("AWS_REGION", region))).toEqual([
        { path: "defaults.env.AWS_REGION", problem: "must be an AWS region name" },
      ]);
    });

    // `regions[]` and `defaults.env.AWS_REGION` are the same kind of value and
    // must not be able to disagree about what one is: the asymmetry between
    // them was the whole of F1.
    it("holds env.AWS_REGION to exactly the shape regions[] is held to", () => {
      for (const region of ["US-EAST-1", "us-east-1a", "us-east", "us-*-1"]) {
        expect(refuse(envValue("AWS_REGION", region))).toHaveLength(1);
        expect(refuse(manifestWith({ regions: [region] }))).toHaveLength(1);
      }
    });

    const MODEL_KEYS = [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] as const;

    // Every model id shape the extension is expected to carry: PRD §17 names
    // inference profile IDs, and an ARN is the other form AWS documents. If one
    // of these is refused the channel cannot ship a legitimate model change.
    it.each([
      ["a bare foundation model id", "anthropic.claude-haiku-4-5-20251001-v1:0"],
      ["a regional inference profile", "us.anthropic.claude-haiku-4-5-20251001-v1:0"],
      ["a global inference profile", "global.anthropic.claude-sonnet-4-6"],
      ["an EU profile", "eu.anthropic.claude-opus-5"],
      [
        "a foundation-model ARN",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5",
      ],
      [
        "an application inference profile ARN",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4",
      ],
      ["an id with an underscore", "us.anthropic.claude_opus_5"],
      ["a 200-character id", "a".repeat(200)],
    ])("accepts %s for every model key", (_name, model) => {
      for (const key of MODEL_KEYS) {
        expect(accept(envValue(key, model)).defaults.env[key]).toBe(model);
      }
    });

    it.each([
      ["longer than the cap", "a".repeat(201)],
      ["a space", "us.anthropic.claude opus"],
      ["a newline", "us.anthropic.claude\nAWS_REGION=evil"],
      ["a control character", "us.anthropic.claude\u0000opus"],
      ["a path traversal", "arn:aws:bedrock:us-east-1::foundation-model/../../evil"],
      ["a query string", "us.anthropic.claude-opus-5?x=1"],
      ["a percent escape", "us.anthropic.claude%2Fopus"],
    ])("refuses a model id containing %s, for every model key", (_name, model) => {
      for (const key of MODEL_KEYS) {
        expect(refuse(envValue(key, model))).toEqual([
          { path: `defaults.env.${key}`, problem: "must be a Bedrock model id" },
        ]);
      }
    });

    it.each(["1", "true", "0", "false"])("accepts the Bedrock flag %s", (value) => {
      expect(accept(envValue("CLAUDE_CODE_USE_BEDROCK", value)).defaults.env).toEqual({
        CLAUDE_CODE_USE_BEDROCK: value,
      });
    });

    it.each([
      ["capitalised", "TRUE"],
      ["a word", "yes"],
      ["a number-like string", "2"],
      ["padded", " 1"],
      ["a shell fragment", "1; curl evil.test"],
    ])("refuses a Bedrock flag that is %s", (_name, value) => {
      expect(refuse(envValue("CLAUDE_CODE_USE_BEDROCK", value))).toEqual([
        { path: "defaults.env.CLAUDE_CODE_USE_BEDROCK", problem: "must be 1, 0, true or false" },
      ]);
    });

    // Fail the field, never coerce: a manifest that said something we could not
    // read meant something we cannot infer, and guessing is how the channel
    // gets to write a value nobody authored.
    it("refuses the whole document rather than dropping one bad value", () => {
      const problems = refuse(
        defaultsWith({
          env: {
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_REGION: "evil.test",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5",
          },
        }),
      );
      expect(problems).toEqual([
        { path: "defaults.env.AWS_REGION", problem: "must be an AWS region name" },
      ]);
    });

    it("never repeats a refused env value back in the problem", () => {
      const sentinel = "us-east-1.attacker.test/sk_do_not_log_me";
      const problems = refuse(envValue("AWS_REGION", sentinel));
      expect(JSON.stringify(problems)).not.toContain("attacker");
    });
  });

  describe("defaults.permissions.deny", () => {
    it("accepts an empty deny list", () => {
      expect(accept(defaultsWith({ permissions: { deny: [] } })).defaults.permissions.deny).toEqual(
        [],
      );
    });

    it.each([
      ["the permissions block is absent", undefined],
      ["permissions is not an object", "deny-everything"],
      ["deny is absent", {}],
      ["deny is an object", { deny: { "0": "Bash(rm:*)" } }],
      ["deny is a string", { deny: "Bash(rm:*)" }],
      ["deny is null", { deny: null }],
    ])("refuses when %s", (_name, permissions) => {
      expect(refuse(defaultsWith({ permissions }))).toContainEqual({
        path: "defaults.permissions.deny",
        problem: "must be an array",
      });
    });

    it("names the index of a deny rule that is not a string", () => {
      expect(
        refuse(defaultsWith({ permissions: { deny: ["Bash(rm:*)", 7, { rule: "x" }] } })),
      ).toEqual([
        { path: "defaults.permissions.deny[1]", problem: "must be a string" },
        { path: "defaults.permissions.deny[2]", problem: "must be a string" },
      ]);
    });
  });

  describe("defaults.extraKnownMarketplaces", () => {
    it("accepts a github source and carries only its two known fields", () => {
      const manifest = accept(
        marketplace({ source: "github", repo: "acme/tools", token: "kept?" }),
      );
      expect(manifest.defaults.extraKnownMarketplaces).toEqual({
        "acme-tools": { source: { source: "github", repo: "acme/tools" } },
      });
    });

    it("accepts an https url source", () => {
      const manifest = accept(marketplace({ source: "url", url: "https://acme.test/market.json" }));
      expect(manifest.defaults.extraKnownMarketplaces).toEqual({
        "acme-tools": { source: { source: "url", url: "https://acme.test/market.json" } },
      });
    });

    it("accepts an empty marketplace map", () => {
      expect(
        accept(defaultsWith({ extraKnownMarketplaces: {} })).defaults.extraKnownMarketplaces,
      ).toEqual({});
    });

    it.each([
      ["a space", "acme tools/x"],
      ["a URL", "https://github.com/acme/tools"],
      ["a traversal inside the path", "acme/../evil"],
      ["a leading traversal with a slash", ".././evil"],
      ["a third segment", "acme/tools/extra"],
      ["no slash at all", "acme"],
      ["nothing", ""],
      ["a shell expansion", "acme/$(whoami)"],
    ])("refuses a github repo containing %s", (_name, repo) => {
      expect(refuse(marketplace({ source: "github", repo }))).toEqual([
        {
          path: "defaults.extraKnownMarketplaces.acme-tools.source.repo",
          problem: "must be owner/name",
        },
      ]);
    });

    // `..` is a legal GitHub owner and name character, so the shape check alone
    // cannot reject `../evil`. It is accepted here and only becomes safe because
    // a consumer builds `github.com/<repo>`, where the segments then normalise
    // away. Worth knowing: the guard is the URL join, not this regex.
    it.each([["../evil"], ["./evil"], ["acme/.."], ["../.."]])(
      "refuses %s, which would resolve to a repository the manifest did not name",
      (repo) => {
        // `new URL("../evil", "https://github.com/")` is `https://github.com/evil`,
        // so a dot segment silently redirects the marketplace somewhere else.
        expect(refuse(marketplace({ source: "github", repo }))).toEqual([
          {
            path: "defaults.extraKnownMarketplaces.acme-tools.source.repo",
            problem: "must be owner/name",
          },
        ]);
      },
    );

    it("still accepts a dot inside an owner or repository name", () => {
      const manifest = accept(marketplace({ source: "github", repo: "a.b/c.d" }));
      expect(manifest.defaults.extraKnownMarketplaces).toEqual({
        "acme-tools": { source: { source: "github", repo: "a.b/c.d" } },
      });
    });

    it.each([
      ["absent", undefined],
      ["a number", 1],
      ["an array", ["acme", "tools"]],
      ["null", null],
    ])("refuses a github repo that is %s", (_name, repo) => {
      expect(refuse(marketplace({ source: "github", repo }))).toEqual([
        {
          path: "defaults.extraKnownMarketplaces.acme-tools.source.repo",
          problem: "must be owner/name",
        },
      ]);
    });

    it.each([
      ["plain http", "http://acme.test/market.json"],
      ["a local file", "file:///home/user/.aws/credentials"],
      ["a script url", "javascript:fetch('https://evil.test')"],
      ["a data url", "data:application/json,{}"],
      ["not a URL at all", "acme.test/market.json"],
      ["a protocol-relative reference", "//acme.test/market.json"],
    ])("refuses a url source using %s", (_name, url) => {
      expect(refuse(marketplace({ source: "url", url }))).toEqual([
        {
          path: "defaults.extraKnownMarketplaces.acme-tools.source.url",
          problem: "must be an https URL",
        },
      ]);
    });

    it.each([
      ["absent", undefined],
      ["a number", 443],
      ["an object", { href: "https://acme.test/" }],
    ])("refuses a url source whose url is %s", (_name, url) => {
      expect(refuse(marketplace({ source: "url", url }))).toEqual([
        {
          path: "defaults.extraKnownMarketplaces.acme-tools.source.url",
          problem: "must be an https URL",
        },
      ]);
    });

    it.each([
      ["a source kind this build does not know", { source: "gitlab", repo: "acme/tools" }],
      ["a local path source", { source: "local", path: "/opt/market" }],
      ["no source discriminator", { repo: "acme/tools" }],
      ["a discriminator that is not a string", { source: 1 }],
    ])("refuses %s", (_name, source) => {
      expect(refuse(marketplace(source))).toEqual([
        {
          path: "defaults.extraKnownMarketplaces.acme-tools.source.source",
          problem: "must be github or url",
        },
      ]);
    });

    it.each([
      ["the entry is a string", "acme/tools"],
      ["the entry is an array", [{ source: { source: "github", repo: "acme/tools" } }]],
      ["the entry is null", null],
      ["the entry has no source", { repo: "acme/tools" }],
      ["source is a string", { source: "github" }],
      ["source is an array", { source: [{ source: "github", repo: "acme/tools" }] }],
    ])("refuses an entry where %s", (_name, entry) => {
      expect(refuse(defaultsWith({ extraKnownMarketplaces: { "acme-tools": entry } }))).toEqual([
        {
          path: "defaults.extraKnownMarketplaces.acme-tools",
          problem: "must have a source object",
        },
      ]);
    });

    it.each([
      ["an array", []],
      ["a string", "acme/tools"],
      ["null", null],
      ["absent", undefined],
    ])("refuses a marketplace map that is %s", (_name, extraKnownMarketplaces) => {
      expect(refuse(defaultsWith({ extraKnownMarketplaces }))).toEqual([
        { path: "defaults.extraKnownMarketplaces", problem: "must be an object" },
      ]);
    });

    /**
     * F9. A marketplace name is remote text that becomes a `settings.json` key
     * and is joined into the `plugins.marketplace` row verbatim, while notice
     * text — which reaches the same panel — is shape-checked, capped and
     * stripped of control characters. A name like
     * `"Claude Code\n\n  ACTION REQUIRED: re-enter your API key"` validated
     * and rendered as its own line under a row the user trusts.
     */
    describe("names", () => {
      function named(name: string): Json {
        return defaultsWith({
          extraKnownMarketplaces: { [name]: { source: { source: "github", repo: "acme/tools" } } },
        });
      }

      it.each([
        ["a plain word", "acme"],
        ["dots and dashes", "acme-tools.v2"],
        ["an underscore", "acme_tools"],
        ["spaces between words", "Acme Tools"],
        ["an at sign", "tools@acme"],
        ["exactly the cap", "a".repeat(64)],
      ])("accepts a marketplace named %s", (_name, name) => {
        expect(Object.keys(accept(named(name)).defaults.extraKnownMarketplaces)).toEqual([name]);
      });

      it("refuses the forged-instruction name from the review", () => {
        expect(refuse(named("Claude Code\n\n  ACTION REQUIRED: re-enter your API key"))).toEqual([
          {
            path: "defaults.extraKnownMarketplaces",
            problem: "name must be 1-64 characters of letters, digits, . _ @ - or space",
          },
        ]);
      });

      it.each([
        ["a newline", "acme\ntools"],
        ["a carriage return", "acme\rtools"],
        ["an escape sequence", "acme\u001B[31mtools"],
        ["a NUL", "acme\u0000tools"],
        ["a delete character", "acme\u007Ftools"],
        ["a bidi override", "acme\u202Etools"],
        ["a slash", "acme/tools"],
        ["a colon", "acme:tools"],
        ["markup", "<b>acme</b>"],
        ["nothing", ""],
        ["one character past the cap", "a".repeat(65)],
      ])("refuses a marketplace named %s", (_name, name) => {
        expect(refuse(named(name))).toEqual([
          {
            path: "defaults.extraKnownMarketplaces",
            problem: "name must be 1-64 characters of letters, digits, . _ @ - or space",
          },
        ]);
      });

      // The name is the offending value here, so unlike every other rejection
      // the path cannot carry it: `defaults.extraKnownMarketplaces.<name>`
      // would put the forged text into the log the fix exists to keep it out of.
      it("keeps a refused name out of the path as well as the problem", () => {
        const problems = refuse(named("Claude Code\n\nACTION REQUIRED sk_do_not_log_me"));
        expect(JSON.stringify(problems)).not.toContain("ACTION REQUIRED");
        expect(JSON.stringify(problems)).not.toContain("sk_do_not_log_me");
      });

      it.each([
        ["a plain id", "linter@acme"],
        ["dots and dashes", "linter.v2@acme-tools"],
        ["no marketplace suffix", "linter"],
        ["exactly the cap", `${"a".repeat(63)}@`],
      ])("accepts a plugin id that is %s", (_name, id) => {
        expect(
          Object.keys(
            accept(defaultsWith({ enabledPlugins: { [id]: true } })).defaults.enabledPlugins,
          ),
        ).toEqual([id]);
      });

      it.each([
        ["a newline", "linter\n\nACTION REQUIRED@acme"],
        ["an escape sequence", "linter\u001B[2K@acme"],
        ["a NUL", "linter\u0000@acme"],
        ["a slash", "linter/acme"],
        ["nothing", ""],
        ["one character past the cap", "a".repeat(65)],
      ])("refuses a plugin id containing %s", (_name, id) => {
        expect(refuse(defaultsWith({ enabledPlugins: { [id]: true } }))).toEqual([
          {
            path: "defaults.enabledPlugins",
            problem: "name must be 1-64 characters of letters, digits, . _ @ - or space",
          },
        ]);
      });

      it("keeps a refused plugin id out of the problem entirely", () => {
        const problems = refuse(
          defaultsWith({ enabledPlugins: { "linter\nsk_do_not_log_me@acme": true } }),
        );
        expect(JSON.stringify(problems)).not.toContain("sk_do_not_log_me");
      });

      // Fail the field, do not sanitise. A name is a settings.json key: a
      // stripped one is a key the manifest did not write, and two names that
      // differ only in the stripped characters would collide into one entry.
      it("refuses a bad name rather than repairing it into a different key", () => {
        const result = validateManifest(named("acme\ntools"));
        expect(result.ok).toBe(false);
      });
    });

    it("refuses the whole document when one of several entries is bad", () => {
      const problems = refuse(
        defaultsWith({
          extraKnownMarketplaces: {
            good: { source: { source: "github", repo: "acme/tools" } },
            bad: { source: { source: "url", url: "http://evil.test/market.json" } },
          },
        }),
      );
      expect(problems).toEqual([
        { path: "defaults.extraKnownMarketplaces.bad.source.url", problem: "must be an https URL" },
      ]);
    });
  });

  describe("defaults.enabledPlugins", () => {
    it("accepts a boolean and a scope list side by side", () => {
      const manifest = accept(
        defaultsWith({
          enabledPlugins: { "linter@acme": true, "fmt@acme": false, "docs@acme": ["user"] },
        }),
      );
      expect(manifest.defaults.enabledPlugins).toEqual({
        "linter@acme": true,
        "fmt@acme": false,
        "docs@acme": ["user"],
      });
    });

    it("accepts an empty scope list", () => {
      expect(
        accept(defaultsWith({ enabledPlugins: { "linter@acme": [] } })).defaults.enabledPlugins,
      ).toEqual({ "linter@acme": [] });
    });

    it.each([
      ["a mixed array", ["user", 1]],
      ["an array of objects", [{ scope: "user" }]],
      ["a number", 1],
      ["null", null],
      ["a string", "true"],
      ["an object", { enabled: true }],
      ["absent", undefined],
    ])("refuses a plugin whose value is %s", (_name, value) => {
      expect(refuse(defaultsWith({ enabledPlugins: { "linter@acme": value } }))).toEqual([
        {
          path: "defaults.enabledPlugins.linter@acme",
          problem: "must be a boolean or an array of strings",
        },
      ]);
    });

    it.each([
      ["an array", []],
      ["a string", "linter@acme"],
      ["null", null],
      ["absent", undefined],
    ])("refuses a plugin map that is %s", (_name, enabledPlugins) => {
      expect(refuse(defaultsWith({ enabledPlugins }))).toEqual([
        { path: "defaults.enabledPlugins", problem: "must be an object" },
      ]);
    });
  });

  describe("regions", () => {
    it.each(["us-east-1", "us-gov-west-1", "ap-southeast-2", "eu-central-1", "ap-northeast-3"])(
      "accepts the region %s",
      (region) => {
        expect(accept(manifestWith({ regions: [region] })).regions).toEqual([region]);
      },
    );

    it.each([
      ["absent", undefined],
      ["an empty array", []],
      ["an object", { "0": "us-east-1" }],
      ["a string", "us-east-1"],
      ["null", null],
    ])("refuses a regions list that is %s", (_name, regions) => {
      expect(refuse(manifestWith({ regions }))).toEqual([
        { path: "regions", problem: "must be a non-empty array" },
      ]);
    });

    it.each([
      ["uppercase", "US-EAST-1"],
      ["an availability zone", "us-east-1a"],
      ["no trailing number", "us-east"],
      ["no separators", "useast1"],
      ["a leading separator", "-us-east-1"],
      ["a wildcard", "us-*-1"],
    ])("refuses a region that is %s", (_name, region) => {
      expect(refuse(manifestWith({ regions: [region] }))).toEqual([
        { path: "regions[0]", problem: "must be an AWS region name" },
      ]);
    });

    it.each([
      ["a number", 1],
      ["null", null],
      ["an array", ["us-east-1"]],
    ])("refuses a regions entry that is %s", (_name, region) => {
      expect(refuse(manifestWith({ regions: ["us-east-1", region] }))).toEqual([
        { path: "regions[1]", problem: "must be an AWS region name" },
      ]);
    });
  });

  describe("credential", () => {
    it.each([
      ["absent", undefined],
      ["an array", []],
      ["a number", 90],
      ["null", null],
    ])("refuses a credential policy that is %s", (_name, credential) => {
      expect(refuse(manifestWith({ credential }))).toEqual([
        { path: "credential", problem: "must be an object" },
      ]);
    });

    it.each([
      ["absent", undefined],
      ["zero", 0],
      ["negative", -1],
      ["fractional", 90.5],
      ["a numeric string", "90"],
      ["null", null],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("refuses a warnAfterDays that is %s", (_name, warnAfterDays) => {
      expect(
        refuse(manifestWith({ credential: { ...(VALID.credential as Json), warnAfterDays } })),
      ).toContainEqual({
        path: "credential.warnAfterDays",
        problem: "must be a positive whole number",
      });
    });

    it.each([
      ["absent", undefined],
      ["zero", 0],
      ["negative", -180],
      ["fractional", 180.25],
      ["a numeric string", "180"],
    ])("refuses a failAfterDays that is %s", (_name, failAfterDays) => {
      expect(
        refuse(manifestWith({ credential: { ...(VALID.credential as Json), failAfterDays } })),
      ).toContainEqual({
        path: "credential.failAfterDays",
        problem: "must be a positive whole number",
      });
    });

    // A warn threshold at or past the fail threshold would skip the warning and
    // jump the user straight to an error about key age.
    it.each([
      ["equal to", 180, 180],
      ["greater than", 200, 180],
    ])("refuses a warnAfterDays %s failAfterDays", (_name, warnAfterDays, failAfterDays) => {
      expect(
        refuse(
          manifestWith({
            credential: { ...(VALID.credential as Json), warnAfterDays, failAfterDays },
          }),
        ),
      ).toContainEqual({
        path: "credential.warnAfterDays",
        problem: "must be less than failAfterDays",
      });
    });

    it("accepts a warn threshold one day short of the fail threshold", () => {
      const credential = { ...(VALID.credential as Json), warnAfterDays: 179, failAfterDays: 180 };
      expect(accept(manifestWith({ credential })).credential.warnAfterDays).toBe(179);
    });

    /**
     * F3. `cred.age` is the only check that expires a credential, and until now
     * the channel could switch it off for every install at once and permanently:
     * `{warnAfterDays: 999999, failAfterDays: 1000000}` validated, and a
     * 26-year-old key reported pass. The clamp is what makes the policy a knob
     * rather than a kill switch.
     */
    describe("threshold bounds", () => {
      function withThresholds(warnAfterDays: unknown, failAfterDays: unknown): Json {
        return manifestWith({
          credential: { ...(VALID.credential as Json), warnAfterDays, failAfterDays },
        });
      }

      it("refuses a failAfterDays that would outlive any key worth expiring", () => {
        expect(refuse(withThresholds(999_999, 1_000_000))).toContainEqual({
          path: "credential.failAfterDays",
          problem: "must be at most 400",
        });
      });

      it("accepts a failAfterDays at the cap", () => {
        expect(accept(withThresholds(399, 400)).credential.failAfterDays).toBe(400);
      });

      it("refuses a failAfterDays one day past the cap", () => {
        expect(refuse(withThresholds(7, 401))).toEqual([
          { path: "credential.failAfterDays", problem: "must be at most 400" },
        ]);
      });

      it("refuses a warnAfterDays that would warn about a key minted this week", () => {
        expect(refuse(withThresholds(1, 180))).toEqual([
          { path: "credential.warnAfterDays", problem: "must be at least 7" },
        ]);
      });

      it("accepts a warnAfterDays at the floor", () => {
        expect(accept(withThresholds(7, 180)).credential.warnAfterDays).toBe(7);
      });

      // The clamp and the ordering rule are independent: neither one implies
      // the other, and a manifest can break both at once.
      it("still refuses warn at or past fail inside the permitted band", () => {
        expect(refuse(withThresholds(200, 180))).toContainEqual({
          path: "credential.warnAfterDays",
          problem: "must be less than failAfterDays",
        });
      });

      it("reports both bound failures rather than stopping at the first", () => {
        expect(refuse(withThresholds(2, 5_000)).map((problem) => problem.path)).toEqual([
          "credential.warnAfterDays",
          "credential.failAfterDays",
        ]);
      });

      // Fail the field, do not coerce: silently rewriting 1_000_000 to 400
      // would leave every install running a policy the manifest never stated.
      it("refuses rather than clamping the value into range", () => {
        const result = validateManifest(withThresholds(999_999, 1_000_000));
        expect(result.ok).toBe(false);
      });
    });

    it("does not compare the thresholds when one of them is unusable", () => {
      const problems = refuse(
        manifestWith({ credential: { ...(VALID.credential as Json), warnAfterDays: "many" } }),
      );
      expect(problems).toEqual([
        { path: "credential.warnAfterDays", problem: "must be a positive whole number" },
      ]);
    });

    it.each([
      ["plain http", "http://console.aws.amazon.com/bedrock"],
      ["a local file", "file:///home/user/keys"],
      ["a script url", "javascript:alert(1)"],
      ["not a URL at all", "console.aws.amazon.com/bedrock"],
      ["empty", ""],
      ["absent", undefined],
      ["a number", 443],
      ["null", null],
    ])("refuses a consoleUrl that is %s", (_name, consoleUrl) => {
      expect(
        refuse(manifestWith({ credential: { ...(VALID.credential as Json), consoleUrl } })),
      ).toContainEqual({ path: "credential.consoleUrl", problem: "must be an https URL" });
    });
  });

  describe("notices", () => {
    it("treats an absent notices list as no notices", () => {
      const input = structuredClone(VALID);
      input.notices = undefined;
      expect(accept(input).notices).toEqual([]);
    });

    it.each([
      ["an object", { "0": { level: "info", message: "hi" } }],
      ["a string", "hi"],
      ["null", null],
      ["a number", 1],
    ])("refuses a notices list that is %s", (_name, value) => {
      expect(refuse(manifestWith({ notices: value }))).toEqual([
        { path: "notices", problem: "must be an array" },
      ]);
    });

    it("round-trips a valid notice including its expiry", () => {
      const notice = {
        level: "warning",
        message: "Bedrock keys issued before June expire soon.",
        expiresAt: "2026-10-01T00:00:00Z",
      };
      expect(accept(notices(notice)).notices).toEqual([notice]);
    });

    it("omits expiresAt entirely when the notice has none", () => {
      const [notice] = accept(notices({ level: "info", message: "hello" })).notices;
      expect(notice).toEqual({ level: "info", message: "hello" });
      expect(notice && "expiresAt" in notice).toBe(false);
    });

    it.each([
      ["a string", "just text"],
      ["an array", ["info", "hello"]],
      ["null", null],
      ["a number", 1],
    ])("refuses a notice that is %s", (_name, entry) => {
      expect(refuse(notices(entry))).toEqual([
        { path: "notices[0]", problem: "must be an object" },
      ]);
    });

    it.each([
      ["absent", undefined],
      ["a level this build does not render", "critical"],
      ["capitalised", "Info"],
      ["a number", 1],
      ["null", null],
    ])("refuses a notice whose level is %s", (_name, level) => {
      expect(refuse(notices({ level, message: "hello" }))).toEqual([
        { path: "notices[0].level", problem: "must be info, warning or error" },
      ]);
    });

    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["only whitespace", "   \n\t "],
      ["a number", 1],
      ["null", null],
      ["an array", ["hello"]],
    ])("refuses a notice whose message is %s", (_name, message) => {
      expect(refuse(notices({ level: "info", message }))).toEqual([
        { path: "notices[0].message", problem: "must be a non-empty string" },
      ]);
    });

    it.each([
      ["not a date", "not-a-date"],
      ["an impossible date", "2026-13-45"],
      ["empty", ""],
      ["a timestamp number", 1_790_000_000_000],
      ["null", null],
      ["an array", ["2026-10-01T00:00:00Z"]],
    ])("refuses a notice whose expiresAt is %s", (_name, expiresAt) => {
      expect(refuse(notices({ level: "info", message: "hello", expiresAt }))).toEqual([
        { path: "notices[0].expiresAt", problem: "must be an ISO 8601 date" },
      ]);
    });

    it("names the index of the offending notice", () => {
      expect(
        refuse(notices({ level: "info", message: "fine" }, { level: "info", message: "" })),
      ).toEqual([{ path: "notices[1].message", problem: "must be a non-empty string" }]);
    });

    it("replaces control characters so a notice cannot forge panel lines", () => {
      const message = "Update\u0000required\u001B[31m now\u007Fplease";
      expect(accept(notices({ level: "info", message })).notices[0]?.message).toBe(
        "Update required [31m now please",
      );
    });

    it("collapses runs of whitespace into single spaces and trims the ends", () => {
      const message = "  Update\t\trequired\n\n  now.  ";
      expect(accept(notices({ level: "info", message })).notices[0]?.message).toBe(
        "Update required now.",
      );
    });

    it("refuses a message that is nothing but control characters", () => {
      // `trim` leaves them in place, so emptiness has to be judged after
      // sanitising or the panel renders a notice row with no text in it.
      expect(refuse(notices({ level: "info", message: "\u0000\u0007\u001B" }))).toEqual([
        { path: "notices[0].message", problem: "must be a non-empty string" },
      ]);
    });

    it("leaves a message of exactly the cap untouched", () => {
      const message = "a".repeat(200);
      expect(accept(notices({ level: "info", message })).notices[0]?.message).toBe(message);
    });

    it("truncates a longer message to the cap, spending the last character on an ellipsis", () => {
      const message = accept(notices({ level: "info", message: "a".repeat(500) })).notices[0]
        ?.message;
      expect(message).toHaveLength(200);
      expect(message?.endsWith("a…")).toBe(true);
    });

    // The cap and expiry are one decision and belong to `selectNotices`, which
    // has a clock; capping here would let expired notices crowd out live ones.
    it("keeps every valid notice, leaving the cap to the caller", () => {
      const four = [1, 2, 3, 4].map((n) => ({ level: "info", message: `notice ${n}` }));
      expect(accept(manifestWith({ notices: four })).notices).toHaveLength(4);
    });

    it("keeps a notice whose expiry has already passed", () => {
      const notice = { level: "info", message: "old", expiresAt: "2000-01-01T00:00:00Z" };
      expect(accept(notices(notice)).notices).toEqual([notice]);
    });
  });

  describe("problem reporting", () => {
    const SENTINEL = "sk_do_not_log_me_0123456789";

    /** Every bad value below carries the sentinel; none of the keys do. */
    function poisoned(): Json {
      return {
        schemaVersion: 1,
        revision: "",
        minExtensionVersion: SENTINEL,
        minimumClaudeCodeVersion: SENTINEL,
        defaults: {
          env: { AWS_REGION: { token: SENTINEL } },
          permissions: { deny: [{ rule: SENTINEL }] },
          extraKnownMarketplaces: {
            store: { source: { source: "url", url: `http://evil.test/${SENTINEL}` } },
          },
          enabledPlugins: { "linter@store": SENTINEL },
        },
        regions: [SENTINEL],
        credential: {
          warnAfterDays: SENTINEL,
          failAfterDays: SENTINEL,
          consoleUrl: `http://evil.test/${SENTINEL}`,
        },
        notices: [{ level: SENTINEL, message: SENTINEL }],
      };
    }

    it("names a path and a problem for every rejection", () => {
      for (const problem of refuse(poisoned())) {
        expect(problem.path).not.toBe("");
        expect(problem.problem).not.toBe("");
      }
    });

    it("reaches every field rather than stopping at the first bad one", () => {
      const paths = refuse(poisoned()).map((problem) => problem.path);
      expect(paths).toEqual([
        "revision",
        "minExtensionVersion",
        "minimumClaudeCodeVersion",
        "defaults.env.AWS_REGION",
        "defaults.permissions.deny[0]",
        "defaults.extraKnownMarketplaces.store.source.url",
        "defaults.enabledPlugins.linter@store",
        "regions[0]",
        "credential.warnAfterDays",
        "credential.failAfterDays",
        "credential.consoleUrl",
        "notices[0].level",
      ]);
    });

    it("never repeats an offending value back in a problem description", () => {
      for (const problem of refuse(poisoned())) {
        expect(problem.problem).not.toContain(SENTINEL);
      }
    });

    it("keeps offending values out of the serialised result entirely", () => {
      expect(JSON.stringify(refuse(poisoned()))).not.toContain(SENTINEL);
    });

    // The one manifest-controlled string that does reach a problem: a path has
    // to name the entry it is about, and marketplace and plugin names are keys.
    it("echoes a marketplace name into the path, since the path must identify the entry", () => {
      expect(
        refuse(
          defaultsWith({
            extraKnownMarketplaces: { [SENTINEL]: { source: { source: "gitlab" } } },
          }),
        ),
      ).toEqual([
        {
          path: `defaults.extraKnownMarketplaces.${SENTINEL}.source.source`,
          problem: "must be github or url",
        },
      ]);
    });
  });

  describe("prototype safety", () => {
    it("drops an own __proto__ key from env without touching Object.prototype", () => {
      const manifest = accept(
        defaultsWith({
          env: parsed('{"__proto__": {"polluted": "yes"}, "AWS_REGION": "us-east-1"}'),
        }),
      );
      expect(manifest.defaults.env).toEqual({ AWS_REGION: "us-east-1" });
      expect(Object.getPrototypeOf(manifest.defaults.env)).toBe(Object.prototype);
      expect(({} as Json).polluted).toBeUndefined();
    });

    it("drops an own __proto__ key from the marketplace map", () => {
      const manifest = accept(
        defaultsWith({
          extraKnownMarketplaces: parsed(
            '{"__proto__": {"source": {"source": "github", "repo": "evil/tools"}}}',
          ),
        }),
      );
      expect(manifest.defaults.extraKnownMarketplaces).toEqual({});
      expect(Object.hasOwn(manifest.defaults.extraKnownMarketplaces, "__proto__")).toBe(false);
      expect(({} as Json).source).toBeUndefined();
    });

    it("drops an own __proto__ key from the plugin map", () => {
      const manifest = accept(
        defaultsWith({ enabledPlugins: parsed('{"__proto__": true, "docs@acme": ["user"]}') }),
      );
      expect(manifest.defaults.enabledPlugins).toEqual({ "docs@acme": ["user"] });
      expect(({} as Json).valueOf).toBe(Object.prototype.valueOf);
    });

    it("treats a constructor key as an ordinary name and leaves Object intact", () => {
      const manifest = accept(
        defaultsWith({
          extraKnownMarketplaces: { constructor: { source: { source: "github", repo: "a/b" } } },
          enabledPlugins: { constructor: true },
        }),
      );
      expect(manifest.defaults.extraKnownMarketplaces).toEqual({
        constructor: { source: { source: "github", repo: "a/b" } },
      });
      expect(manifest.defaults.enabledPlugins).toEqual({ constructor: true });
      expect(typeof Object.prototype.constructor).toBe("function");
    });

    it("returns plain objects a caller can safely enumerate and serialise", () => {
      const manifest = accept(VALID);
      for (const value of [
        manifest.defaults,
        manifest.defaults.env,
        manifest.defaults.permissions,
        manifest.defaults.extraKnownMarketplaces,
        manifest.defaults.enabledPlugins,
        manifest.credential,
      ]) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      }
    });
  });
});

/**
 * F10. Every collection was unbounded, so 20,000 marketplaces + 20,000 plugins
 * + 20,000 deny rules validated, `merge` produced a settings document over a
 * megabyte, and the writer atomically wrote it to disk. That is a permanent
 * denial of service against Claude Code's own config parse — delivered over the
 * channel and surviving removal of the manifest, because the damage is in the
 * user's file rather than in the manifest.
 *
 * Each cap fails the field rather than truncating: a truncated collection is a
 * set of defaults nobody authored, and which half survives is an accident of
 * key order.
 */
describe("collection caps", () => {
  function repeated<T>(count: number, make: (index: number) => [string, T]): Record<string, T> {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => make(index)));
  }

  function marketplaces(count: number): Json {
    return defaultsWith({
      extraKnownMarketplaces: repeated(count, (index) => [
        `market-${index}`,
        { source: { source: "github", repo: `acme/tools-${index}` } },
      ]),
    });
  }

  function plugins(count: number): Json {
    return defaultsWith({
      enabledPlugins: repeated(count, (index) => [`linter-${index}@acme`, true]),
    });
  }

  function denyRules(count: number): Json {
    return defaultsWith({
      permissions: { deny: Array.from({ length: count }, (_, index) => `Bash(cmd-${index}:*)`) },
    });
  }

  function regionList(count: number): Json {
    return manifestWith({
      regions: Array.from({ length: count }, (_, index) => `us-east-${index + 1}`),
    });
  }

  function noticeList(count: number): Json {
    return manifestWith({
      notices: Array.from({ length: count }, (_, index) => ({
        level: "info",
        message: `notice ${index}`,
      })),
    });
  }

  it.each([
    ["defaults.permissions.deny", 64, denyRules],
    ["defaults.extraKnownMarketplaces", 32, marketplaces],
    ["defaults.enabledPlugins", 64, plugins],
    ["regions", 32, regionList],
    ["notices", 16, noticeList],
  ])("accepts exactly %s entries at the cap for %s", (_path, cap, build) => {
    expect(validateManifest(build(cap)).ok).toBe(true);
  });

  it.each([
    ["defaults.permissions.deny", 64, denyRules],
    ["defaults.extraKnownMarketplaces", 32, marketplaces],
    ["defaults.enabledPlugins", 64, plugins],
    ["regions", 32, regionList],
    ["notices", 16, noticeList],
  ])("refuses one entry past the cap for %s", (path, cap, build) => {
    expect(refuse(build(cap + 1))).toContainEqual({
      path,
      problem: `must have at most ${cap} entries`,
    });
  });

  // The reviewer's document: individually valid entries, collectively a
  // settings.json no editor will open again.
  it("refuses the 20,000-entry document that would brick the config parse", () => {
    const oversized = structuredClone(VALID);
    const defaults = oversized.defaults as Json;
    defaults.extraKnownMarketplaces = (
      marketplaces(20_000).defaults as Json
    ).extraKnownMarketplaces;
    defaults.enabledPlugins = (plugins(20_000).defaults as Json).enabledPlugins;
    defaults.permissions = (denyRules(20_000).defaults as Json).permissions;

    expect(refuse(oversized).map((problem) => problem.path)).toEqual([
      "defaults.permissions.deny",
      "defaults.extraKnownMarketplaces",
      "defaults.enabledPlugins",
    ]);
  });

  // Fail, do not truncate: which 64 of 20,000 survive is an accident of key
  // order, and the result is a set of defaults nobody wrote.
  it("refuses an oversized collection rather than keeping its first entries", () => {
    expect(validateManifest(denyRules(65)).ok).toBe(false);
  });

  // The cap is on the collection, not a substitute for checking what is in it.
  it("still checks every entry of a collection inside the cap", () => {
    expect(refuse(defaultsWith({ permissions: { deny: ["ok", 7] } }))).toEqual([
      { path: "defaults.permissions.deny[1]", problem: "must be a string" },
    ]);
  });

  // `selectNotices` shows two; the cap is 16 because validation has no clock
  // and must not let expired notices crowd out live ones (Q-AA).
  it("keeps the notices cap above what the panel renders", () => {
    expect(accept(noticeList(16)).notices).toHaveLength(16);
    expect(selectNotices(accept(noticeList(16)).notices, new Date())).toHaveLength(2);
  });
});

describe("selectNotices", () => {
  const NOW = new Date("2026-09-11T00:00:00Z");

  function notice(over: Partial<ManifestNotice> = {}): ManifestNotice {
    return { level: "info", message: "hello", ...over };
  }

  it("keeps a notice with no expiry", () => {
    expect(selectNotices([notice()], NOW)).toEqual([notice()]);
  });

  it("keeps a notice whose expiry is still ahead", () => {
    const live = notice({ expiresAt: "2030-01-01T00:00:00Z" });
    expect(selectNotices([live], NOW)).toEqual([live]);
  });

  it("drops a notice whose expiry has passed", () => {
    expect(selectNotices([notice({ expiresAt: "2000-01-01T00:00:00Z" })], NOW)).toEqual([]);
  });

  it("drops a notice expiring exactly now", () => {
    expect(selectNotices([notice({ expiresAt: NOW.toISOString() })], NOW)).toEqual([]);
  });

  it("keeps a notice whose expiry cannot be read rather than silently hiding advice", () => {
    const unreadable = notice({ expiresAt: "whenever" });
    expect(selectNotices([unreadable], NOW)).toEqual([unreadable]);
  });

  it("shows at most two notices", () => {
    const four = [1, 2, 3, 4].map((n) => notice({ message: `notice ${n}` }));
    expect(selectNotices(four, NOW).map((n) => n.message)).toEqual(["notice 1", "notice 2"]);
  });

  it("fills both slots from live notices rather than letting expired ones take them", () => {
    const selected = selectNotices(
      [
        notice({ message: "expired", expiresAt: "2000-01-01T00:00:00Z" }),
        notice({ message: "live 1" }),
        notice({ message: "live 2" }),
        notice({ message: "live 3" }),
      ],
      NOW,
    );
    expect(selected.map((n) => n.message)).toEqual(["live 1", "live 2"]);
  });

  it("returns nothing for an empty list", () => {
    expect(selectNotices([], NOW)).toEqual([]);
  });
});
