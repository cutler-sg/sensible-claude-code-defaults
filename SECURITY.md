# Security

This extension handles an AWS Bedrock API key on the user's behalf. If you
find a way for that key to reach a file, a log, a diagnostics report, a
network request, or a process it should not, please report it privately.

## Reporting

Email **security@cutler.sg**. Include the extension version, your platform,
and enough detail to reproduce. Please do not open a public issue for
anything involving credential exposure.

You will get an acknowledgement within three working days.

## Scope

In scope:

- Any path by which the Bedrock key leaves the OS keychain or the user's
  `~/.claude/settings.json` other than the ones the README documents.
- Any write outside `~/.claude`, in particular into a workspace folder.
- Any request to a host other than the two the README names.
- A validated defaults manifest that can point Claude Code at a host other
  than AWS.

Out of scope:

- Claude Code passing the key to subprocesses and MCP servers via the
  environment. That is how Claude Code works, and the README says so.
- A key already committed to git history. Rotate it.

## Supported versions

Only the latest published version receives fixes.
