/**
 * Dotted-numeric version comparison for the FR-1.6 floor check.
 *
 * A pre-release or build suffix is dropped rather than ordered. The only
 * question asked here is "is the installed Claude Code below the floor", and
 * `1.98.0-insider` is the 1.98.0 the user has — ordering it below 1.98.0 would
 * nag an insider build that already meets the floor.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // Missing segments are zero, so `2.1` and `2.1.0` compare equal.
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * Anything unparseable becomes zero rather than throwing: the input is a
 * version string from another extension's `package.json` or from a CLI's
 * stdout, and a health check must not fail because one of them is odd.
 */
function parse(version: string): number[] {
  const core = version
    .trim()
    .replace(/^v/, "")
    .replace(/[-+].*$/, "");
  return core.split(".").map((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isNaN(value) ? 0 : value;
  });
}
