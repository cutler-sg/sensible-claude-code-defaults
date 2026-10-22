# Maintenance backlog

Updated 2026-10-22. This is the current backlog; historical milestone and research
plans describe earlier decisions and proposals. Release preparation is tracked in
[the 1.2.1 plan](../plans/fix-dependency-audit-39565962529.md).

## Release 1.2.1

- [x] Patch the `follow-redirects` and Vite development dependency advisories in PR #54.
- [x] Fix U1 from the [UX review](uiux-review-2026-09-30.md): a successful credential
  recovery must supersede an older rejection after subsequent offline or
  rate-limited checks. Preserve expiry, newer rejections, and credential/context
  isolation. Model access must remain inconclusive after a transient failure.
- [x] Complete packaged desktop verification, including upgrade consent, drift,
  backup/restore, and the recovered-credential sequence. The interrupted
  2026-10-22 run is partial evidence only.
- [x] Validate the release candidate and retain the existing manual-environment
  limitations in its handoff. Publication follows the reviewed merge.

The [release handoff](release-1.2.1.md) and
[completed desktop report](verification-1.2.1/README.md) record the results.
The final PR checks and reviewed publication steps remain the release gates.

## Deferred UX proposals

These findings were recorded on 2026-09-30. Preserve their evidence and
acceptance criteria before implementation; they do not authorize a redesign as
part of 1.2.1.

| Review IDs | Proposal | Acceptance criteria |
| --- | --- | --- |
| U2, U9 | Lead with configured models and their exact routes; disclose the full catalogue on demand. | A narrow sidebar makes configured access and blocked optional upgrades distinguishable without horizontal scrolling. |
| U3 | Show a readable model/version/scope comparison in upgrade consent. | The complete old and new versions are visible; Cancel remains the default, and full IDs remain inspectable. |
| U4 | Match recovery actions to rejected credentials, access denial, and transient failures. | Each outcome offers the relevant replace-key, administrator-request, or retry action. |
| U5 | Preserve reading position and focus during model refresh. | Refresh retains table/document scroll and the active control without interrupting keyboard use. |
| U6–U8, U10–U11 | Clarify setup disclosures, completion, policy labels, Details navigation, and accessible states. | Verify the proposed flows with keyboard input and a screen reader before claiming accessibility compliance. |

The complete review and original plan are preserved in
[the UX review](uiux-review-2026-09-30.md) and
[its proposal checklist](../plans/docs-uiux-review-2026-09-30.md).

## Future provider support

Azure Foundry remains research, not a shipped capability. Preserve
[the dated research](azure-foundry-model-availability-research.md) and
[its implementation plan](../plans/docs-azure-foundry-availability-plan.md).
Revalidate external API/authentication contracts and obtain a designated live
test environment before implementation.

## Operations and environment follow-up

- Duplicate repair dispatches are owned by the external Hadron service. The
  daily dependency audit remains enabled. Its investigation routing must reuse
  an existing repair PR across daily run IDs and permit compatible dependency
  repairs; repository documentation alone cannot change the active dispatcher.
  Exact ownership and acceptance criteria are in [the automation handoff](automation-handoff.md).
- Live AWS entitlement, routing, billing, and subscription behaviour require a
  designated account. Synthetic fixtures do not establish those properties.
- Physical Keychain/DPAPI, corporate-device policy, WSL/Remote-SSH placement,
  and screen-reader checks remain in [manual verification](manual-verification.md)
  and [corporate retesting](corporate-device-retest.md).
- Open VSX publication remains optional and awaits namespace/token setup.

## Branch inventory

The four research/review documents above came from local branch
`docs/uiux-review-2026-09-30`, which includes
`docs/azure-foundry-availability-plan`. Their source commits are `717d346` and
`e18435a`; product code below them was already merged through PR #49.

Closed recovery PR #50 contains a version-test snapshot identical to the current
test (`46a7c716f08ffbf70d7652a3f3cb80c5545bd873`). Its archive is not a missing
product fix. Dependabot PR #52 was superseded by merged PR #53. Other old task
branches are predominantly squash-merged history. Delete branches/worktrees
only after confirming their contents are preserved and obtaining deletion
authorization; deletion is not a release prerequisite.
