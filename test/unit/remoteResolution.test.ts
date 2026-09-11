import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaudeDir } from "../../src/config/paths.js";

/**
 * FR-1.3 / §10.3 / §15 "WSL homedir mismatch" — the shape of the answer when
 * the extension host is on the far side.
 *
 * `resolveClaudeDir` takes the home directory as an argument, so a remote
 * environment can be handed to it whole. That is the point of the signature:
 * the function has no way to reach a client-side value, because its only
 * inputs are the environment and the home of whichever process calls it — and
 * under Remote-SSH, WSL or a devcontainer that process is the remote one.
 *
 * These cases are the four homes §10.3 names. They are unit tests, so what they
 * establish is that resolution is a function of its inputs and carries no
 * platform branch that could reintroduce a client path (FR-1.2: "do not branch
 * on platform"). What they cannot establish is that the extension host is
 * actually placed on the remote side, or that the wiring passes the host's own
 * home in. `test/unit/packageJson.test.ts` covers the first (no
 * `extensionKind`); `test/integration-vscode/resolution.spec.ts` covers the
 * second; `docs/manual-verification.md` items 3 and 4 close what neither can.
 *
 * Expectations are built with the same `path` primitive the function itself
 * uses, because the *runner* may be Windows even when the home under test is a
 * POSIX remote one. The default branch is `path.join(home, '.claude')`, which
 * adds no drive; the `CLAUDE_CONFIG_DIR` branch ends in `path.resolve`, which
 * on Windows does. Spelling either as a bare `/home/...` literal would assert
 * the runner's platform rather than where the config lands, and spelling both
 * the same way gets one of them wrong. The remote-vs-client distinction each
 * case is really about survives either normalisation untouched.
 */
describe("resolveClaudeDir on a remote extension host (FR-1.3)", () => {
  /** A WSL2 distro's home. Not `/mnt/c/Users/...`, which is the Windows side. */
  const WSL_HOME = "/home/mc";
  /** A Remote-SSH login on a Linux server. */
  const SSH_HOME = "/home/deploy";
  /** A devcontainer's non-root user. */
  const CONTAINER_HOME = "/home/vscode";
  /** The Windows client the above are reached *from* — never the answer. */
  const WINDOWS_HOME = "C:\\Users\\Michael";

  it("resolves under the WSL home, not the Windows profile it is reached from", () => {
    const resolved = resolveClaudeDir({}, WSL_HOME);
    expect(resolved).toBe(path.join(WSL_HOME, ".claude"));
    // The §10.3 row, as an assertion: "writes land in the WSL home, not the
    // Windows home". Both halves, because the first alone would also pass for a
    // path that happened to contain the right substring.
    expect(resolved).not.toContain("Users");
    // `endsWith`, not `startsWith`: a Windows runner prefixes a drive letter,
    // which changes the head of the string without changing which home the
    // config lands in. The tail is the part the claim is about.
    expect(resolved.endsWith(path.join(WSL_HOME, ".claude"))).toBe(true);
  });

  it("resolves under the SSH login's home on the server", () => {
    expect(resolveClaudeDir({}, SSH_HOME)).toBe(path.join(SSH_HOME, ".claude"));
  });

  it("resolves under the devcontainer user's home", () => {
    expect(resolveClaudeDir({}, CONTAINER_HOME)).toBe(path.join(CONTAINER_HOME, ".claude"));
  });

  it("gives a different answer for each side, so the sides cannot be confused", () => {
    // The mismatch §15 names, stated as the thing that must not happen. If
    // resolution ever collapsed to one machine's home — a cached value, a
    // client-side lookup — these would converge and this is where that shows.
    const homes = [WSL_HOME, SSH_HOME, CONTAINER_HOME];
    const resolved = homes.map((home) => resolveClaudeDir({}, home));
    expect(new Set(resolved).size).toBe(homes.length);
  });

  it("honours a CLAUDE_CONFIG_DIR that is itself a remote path", () => {
    // Plan Q-F's override is read from the *host's* environment, so on a remote
    // host it is the remote shell's value and names a remote directory. A
    // client-side value could never reach it.
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "~/cfg" }, SSH_HOME)).toBe(
      path.resolve(path.join(SSH_HOME, "cfg")),
    );
  });

  it("never yields the client's home just because the client is Windows", () => {
    // The regression in one line. A Windows client reaching a Linux remote: the
    // answer is the remote's, and nothing about the client appears in it.
    const resolved = resolveClaudeDir({}, WSL_HOME);
    expect(resolved).not.toBe(path.join(WINDOWS_HOME, ".claude"));
    expect(resolved.toLowerCase()).not.toContain("c:\\");
  });
});
