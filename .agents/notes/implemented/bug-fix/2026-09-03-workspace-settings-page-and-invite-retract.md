# Agent Note: Workspace settings page and retracted invitation wizard

Status: implemented

English | [中文](2026-09-03-workspace-settings-page-and-invite-retract.zh.md)

## Problem

Workspace settings shipped as a compact `min(480px)` dialog while the accepted product is a settings page: named title, path, Git remote as a code row, and a collaboration card. Independently, the invite wizard could keep offering a retracted invitation. `pendingInvitations()` still returned that id, confirm still POSTed `decide`, and a 409 `INVITATION_NOT_PENDING` surfaced as `Error invoking remote method 'projectMembership:decide'`. Link radios could also show a parent-folder Host title such as `IdeaProjects` instead of the checkout basename.

## Decision

The settings dialog is a headless page: `min(820px, calc(100vw - 64px))` by `min(760px, calc(100vh - 64px))`, named title, optional path, Git remote in a code row, collaboration card. Git-less create stays name-only; project and origin still load independently. Modal `className` remains `string`; the owner throws when `.settingsDialog` is missing.

The wizard never submits or re-offers an invitation that left the pending pool. `decide` failures with `INVITATION_NOT_PENDING`, `INVITATION_NOT_FOUND`, or a retracted/not-pending message close the wizard, record that id, and skip it on later polls. Create, invite, retract, roster, and other decide failures map to the same short dictionary copy and never keep the Electron IPC prefix. Link radios use the checkout basename.

Roster presence is a 16px overflow-hidden slot: the green/offline dot is visible, and `members.online` / `members.offline` live only in `.visuallyHidden` plus the `title` tooltip. Without that clip, the two-character label wraps inside the slot and stacks next to the GitHub login.

## Supersession check

[The Git-less create and byRemote 404 note](2026-09-03-workspace-upgrade-gitless-create-and-byremote-404.md) still owns name-only create, independent loads, and 404-as-unbound. This note only replaces the compact dialog chrome and the retracted-invite poll. [The invitation role picker note](../feature/2026-09-02-invitation-granted-role.md) still owns grant policy.

## Alternatives considered

**Keep the compact dialog and only widen it.** Rejected: the accepted surface is the page with header and cards, not a larger card of the same form.

**Copy the t7 page including remote-required create and the access gate.** Rejected: Git-less create and independent origin loads already shipped; baseline does not pass `access` / `openSignIn`.

**Leave a mapped 409 alert in the still-open wizard.** Rejected: a retracted invitation is not pending, so the wizard must close and drop that id rather than invite another submit.

## Consequences

Settings reopen as a page without requiring origin. A retracted invitation cannot stay on screen or reappear from the poll. Parent-folder Host titles no longer appear as wizard radios.

## Testing

- `packages/client/ui-workspace/tests/workspace-settings.client.spec.tsx` pins page chrome, git-less create, mapped decide copy, and a retracted id that does not reopen after 409.

## Related

- Issue #531
- [Workspace settings Git-less Cloud Project create and byRemote 404](2026-09-03-workspace-upgrade-gitless-create-and-byremote-404.md)
