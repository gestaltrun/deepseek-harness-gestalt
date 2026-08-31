# `@deepseek-ai/dsh-project-membership`

English | [中文](README.zh.md)

Project Membership Service Definition for cloud projects: a project binds one normalized git remote as a validated unique property and carries memberships with the three permission roles `owner|admin|member` plus project-defined function tags. A remote belongs to at most one Project in an environment (`PROJECT_REMOTE_TAKEN`), so recovery cannot choose an arbitrary association. Roles govern only this collaboration plane; they never derive from Git-platform permissions, and Git permissions never derive from them.

Invitations move through `pending → accepted | declined | retracted`. Acceptance is atomic with linking exactly one local workspace, so no joined-but-unlinked state can exist; a duplicate invitation to an account that already holds a membership or pending invitation is rejected atomically with `DUPLICATE_INVITEE`, under concurrency included. Every mutation executes its role gate inside the operation: admins invite but cannot touch owner rows or remove owners, only owners hand out the owner role, and the final owner cannot be demoted or removed (`LAST_OWNER`). Function tags are freeform display-and-routing labels — capped at 8 distinct tags of up to 32 visible characters — carried through every roster view and never permission-bearing; editing them requires admin or owner.

Reading is gated too: `roster` requires an active membership of the caller, so removed accounts lose enumeration immediately. Each mutation that changes what a roster view returns publishes one `project-membership/roster-invalidated` event strictly after durability, carrying both roster projection versions; consumers key caches on `rosterVersion(projectId)` and rebuild from the event instead of trusting stale views.

## Service surface

`createProject(actor, {name, remoteUrl})` (creator becomes founding owner) · `invite` · `retractInvitation` (issuer or owner) · `acceptInvitation` · `declineInvitation` (addressee; addressee identity stays private, so other accounts see `INVITATION_NOT_FOUND`) · `changeRole` · `setMemberTags` · `removeMember` · `roster` · `pendingInvitationsFor` · `pendingInvitationsIssuedBy` (admin-or-owner) · `projectByRemote` · `rosterVersion`.

Stable failure codes: `DUPLICATE_INVITEE`, `ROLE_REQUIRED`, `NOT_A_MEMBER`, `PROJECT_NOT_FOUND`, `MEMBERSHIP_NOT_FOUND`, `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, `PROJECT_NAME_TAKEN`, `INVALID_PROJECT_NAME`, `INVALID_REMOTE_URL`, `INVALID_TAGS`, `LAST_OWNER`, `INVALID_LINK`.

`normalizeGitRemoteUrl` produces the canonical binding form from `https://host/path[.git]` and scp-like `user@host:path[.git]` spellings: scheme/host lower-cased, one terminal `.git` suffix dropped case-insensitively, trailing slashes trimmed, mid-path segments untouched. Browser bundles that need only this pure operation import `@deepseek-ai/dsh-project-membership/remote-url`; the subpath carries no Service or registry identity.

## Model Experience

None, as Project Membership authority stays outside agent sessions and model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- This package defines vocabulary and gates only; it owns no storage. The file-backed development provider lives in [`dsh-project-membership-core`](../project-membership-core/README.md), and operated deployments supply their own backend.
- Routed member questions and presence derivation consume this capability but are not part of it; production activation of routed questions stays behind the standing encryption review gate recorded in [the placement Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-project-membership-core.md).
