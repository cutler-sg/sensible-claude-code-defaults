# Release candidate 1.2.0

Prepared for the stable Marketplace channel. This document describes a candidate;
no tag, GitHub release, or registry submission is implied.

## Release notes

Bedrock model checks now verify the exact configured Opus, Sonnet, and Haiku
targets independently. The availability matrix distinguishes successful
invocation from metadata, access denial, stale evidence, and transient errors.
Upgrade recommendations preserve working pins and user edits, and still require
the normal configuration preview before applying.

Automatic checks remain off until explicitly enabled after disclosure of
billable probes and possible AWS subscription effects. Calls are bounded,
cached, deduplicated across windows, and restricted by the chosen processing
geographies. No project content is sent in the probes.

Retrying a failed settings apply now preserves the backup allowance when the
original file was unchanged or restored successfully. Edits made after the
failure are backed up before the retry replaces them.

Development dependencies include the patched `source-map-js` resolution.
Daily dependency audits cover the frozen transitive graph independently of
GitHub's alert inventory. CI now checks both supported VS Code endpoints and
the new Ubuntu 26.04 runner image.

## Submission decisions

- Version **1.2.0** is a backwards-compatible feature release. This repository
  reserves odd minor versions for pre-releases, so 1.1.0 would select the wrong
  channel. The VS Code API floor remains 1.98.0.
- Retain the configured Entra workload identity in `marketplace-publish`.
  Both required secret names exist; no credential contents were inspected.
- The Release workflow fails if Marketplace identity configuration is missing.
  It uploads and submits the same VSIX, with the channel marker added during
  packaging. Open VSX remains conditional on its separate configuration.
- Reuse [PR #53](https://github.com/cutler-sg/sensible-claude-code-defaults/pull/53)
  for the dependency repair and all release preparation.

## Validation

- Frozen dependency installation and `bun audit`: pass with Bun 1.4.3;
  the locally installed Bun 1.3.14 also reports a clean audit.
- Lint and typechecking: pass.
- Unit tests: 2,088 pass, two existing skips, 57 files.
- Linux extension hosts: seven pass and one existing Windows-only skip each
  on VS Code 1.142.0 and 1.98.2, using isolated profiles and Claude directories.
- Workflow channel selection: stable/pre-release selection passes; mismatched
  tags, suffixes, leading zeros, and absent Marketplace configuration fail.
- Stable, pre-release, and clean Open VSX packager archives contain the ten
  expected files, correct channel metadata, model catalogue, and icons. No
  source maps, `node_modules`, test fixtures, `preview`, or `extensionKind`
  override is present. The stable candidate is 105,877 bytes.
- A clean dependency installation confirms Open VSX uses VSCE 4.0.0 and passes
  the same typecheck and full unit suite. Independent review found no blockers.
- Candidate `3d04b9a` passed all nine GitHub checks. The
  [hosted CI run](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/39433029054)
  passed both VS Code versions across Windows, macOS, Ubuntu, Ubuntu 26.04,
  and no-keyring Linux. Audit, packaging, and CodeQL also passed.
- The downloaded hosted VSIX passes the archive checks. Its SHA-256 is
  `69b6f6cb6b5d34cdabef06d7224cb4f1086ea074d76387a39d6a879aa0fe7971`.
  See the [branch plan](../plans/dependabot-bun-dev-dependencies-093941c988.md)
  for additional evidence and PR #53 for completion-commit check status.

## Outstanding environment checks

The existing release records carry physical-platform checks as accepted,
unverified risk. This candidate retains that distinction:

- Live AWS account entitlement, actual subscription behaviour, billing, and
  regional routing have not been tested with a real credential.
- Physical macOS Keychain and Windows DPAPI prompts, corporate-device policies,
  WSL2/Remote-SSH placement, and screen-reader output need the
  [manual verification](manual-verification.md) and
  [corporate retest](corporate-device-retest.md) environments.
- Model UI evidence uses synthetic AWS responses; see the
  [model verification report](model-availability-verification.md).
- Open VSX namespace/token setup is still absent. The Marketplace submission
  does not depend on it.

## Final submission

Follow [the release runbook](releasing.md). Merge the reviewed PR, verify the
merged commit's checks, and date the 1.2.0 changelog when publication is scheduled.
Only then create the individual annotated `v1.2.0` tag and publish it.

After the Release workflow succeeds, verify the Marketplace version and stable
channel directly, and attach the workflow's exact VSIX to the GitHub release
with the release notes above. A successful packaging job alone is not evidence
that a registry received the submission.
