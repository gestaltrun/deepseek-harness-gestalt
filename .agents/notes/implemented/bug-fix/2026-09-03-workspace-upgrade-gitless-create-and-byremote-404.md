# Agent Note: Workspace settings Git-less Cloud Project create and byRemote 404

Status: implemented

English | [中文](2026-09-03-workspace-upgrade-gitless-create-and-byremote-404.zh.md)

## Problem

Desktop Workspace settings could not complete Cloud Project create. The 云项目名称 field had no visible box, Git remote appeared only as a focus ring, and the dialog used undefined `--ds-bg-input` / `--ds-border` tokens. The settings modal was `min(380px)` with `overflow: hidden` while the upgrade section was `min-width: 420px`, so copy and the name field clipped. Opening settings called `projectByRemote`; production Platform answers a missing membership with HTTP 404, while the client treated only 204 as unbound. The settings `Promise.all` catch then cleared a successfully read Git origin and showed `ProjectMembershipClientError … HTTP_404`. A Workspace without origin could not create a Cloud Project.

## Decision

`projectByRemote` treats HTTP 204 and production HTTP 404 as unbound. Other non-OK answers still reject. `pendingInvitations` treats HTTP 204 and production HTTP 404 as an empty list. Desktop's official-Node HTTPS helper reconstructs 204/205/304 with a null Fetch body so heartbeat and unbound `by-remote` do not throw `Invalid response status code 204`. Workspace settings loads the current Account's Project and the local Git remote independently, so an unbound 404 cannot wipe a successfully read origin. `createBlocked` is name-only: Git remote is optional and read-only when present.

A Workspace without origin, or whose origin fails `normalizeGitRemoteUrl`, creates and recovers through `localWorkspaceRemoteUrl(workspaceId)`, the canonical Platform remote `local://workspace/<id>`. The identity stays case-exact; empty ids and ids containing `/`, `?`, or `#` remain `INVALID_REMOTE_URL`. Browser bundles import that constructor from `@deepseek-ai/dsh-project-membership/remote-url`. Create still persists the founder Account/Project/Workspace binding before the roster renders. Reopening settings on that exact Workspace recovers through origin when present, otherwise the sentinel.

Inputs use `--dsw-alias-border-l2`, `--dsw-alias-bg-layer-1`, and `--dsw-alias-brand-primary`. Dialog chrome is owned by [the settings page and retracted invitation note](2026-09-03-workspace-settings-page-and-invite-retract.md).

## Supersession check

[The project-membership authority note](../feature/2026-08-27-project-membership-core.md) still owns uniqueness, roles, and Platform placement; this note extends the unique remote property with the Git-less sentinel and records the client 404 mapping. [The invitation role picker note](../feature/2026-09-02-invitation-granted-role.md) still owns grant policy. Neither is superseded.

## Alternatives considered

**Require a Git origin before create.** Rejected: a non-Git Workspace is a valid product checkout, and production acceptance failed on that path. Origin remains the recovery key when present.

**Treat production 404 as a transport failure and surface it in the dialog.** Rejected: production Platform uses 404 for unbound membership; treating it as failure blocked create on every unbound Git checkout and cleared a successful origin read.

**Keep one `Promise.all` for project and Git remote.** Rejected: a single catch coupled independent facts, so an unbound 404 wiped origin.

**Invent a second Project identity besides the unique remote.** Rejected: `PROJECT_REMOTE_TAKEN` already requires one canonical remote per Project. The sentinel extends that unique property rather than adding a parallel key.

## Consequences

Git-less create binds the local Workspace through `local://workspace/<id>` and recovers on reopen without origin. Unbound production 404s no longer block the dialog or erase origin. Visible `--dsw-alias` input chrome and the wider dialog keep name and remote readable. Platform still treats a remote as unique across Git origins and sentinels; two Workspaces cannot share one sentinel identity.

The Desktop agent `/v1/context` bridge uses the same recovery: Git origin when present, otherwise `local://workspace/<id>` from the Host Workspace identity. Without that, `project_members` answers `PROJECT_UNBOUND` on a Git-less bound Workspace and the model hunts files for a project id.

## Testing

- `packages/platform/project-membership-client/tests/membership-client.client.spec.ts` pins production 404 as unbound and pending 204/404 as an empty list.
- `apps/desktop/tests/system-node-fetch-helper.spec.ts` reconstructs membership heartbeat HTTP 204 without a Fetch body.
- `packages/platform/project-membership/tests/remote-url.spec.ts` pins `local://workspace/<id>` and rejects empty or nested identities.
- `packages/client/ui-workspace/tests/apply.client.spec.ts` pins Git-less create and sentinel recovery.
- `packages/client/ui-workspace/tests/workspace-settings.client.spec.tsx` pins name-only `createBlocked`, independent remote load, and visible Git-less create.
- `apps/desktop/tests/project-membership-agent-runtime.spec.ts` pins Git-less `/v1/context` lookup through `local://workspace/<id>`.
- `packages/platform/project-membership-desktop/tests/desktop-provider.spec.ts` pins forwarding the Workspace identity with the cwd.

## Related

- Issue #531
- [Project membership authority](../feature/2026-08-27-project-membership-core.md)
