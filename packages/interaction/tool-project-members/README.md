# @deepseek-ai/dsh-tool-project-members

English | [中文](README.zh.md)

Model-facing `project_members` tool over `ctx.projectMembership`: one read that returns the full roster of a cloud project — each member's account reference, public display identity, permission role, project-defined function tags, and presence — with no role-based restriction on querying.

## Tool

`project_members` accepts one optional argument:

- `projectId` — the cloud project to query. Omitted, the tool asks the composition's workspace binding which project the current workspace maps to; an explicit id wins.

The call resolves the session-bound account first, then the project binding, then reads the stored roster through an injected resolver or `ctx.projectMembership.roster()`. The canonical result is the member array `[{ accountId, displayName?, avatarRef?, role, tags, presence }]` in join order; every stored member appears or the call fails — there are no partial rosters.

## Injected provider faces

The package imports only the membership Service Definition — never a platform provider package. The composition injects four optional Config functions; account, project, and roster resolvers receive the current Agent and tool cancellation signal so a Host adapter can derive Workspace context without model-supplied identity and stop pending reads:

- `currentAccountResolver` — resolves the current session-bound account. Absent, rejecting, or resolving to `undefined` answers the stable `ACCOUNT_UNAVAILABLE` error.
- `boundProjectResolver` — resolves the workspace-bound project for calls that omit `projectId`. Unresolvable answers the stable `PROJECT_UNBOUND` error.
- `rosterResolver` — reads the authoritative roster through a composition-owned authenticated bridge. Absent, the tool uses `ctx.projectMembership.roster()` and fails if neither source is composed.
- `rosterPresenter` — attaches presence and public display identity to one read. Absent, every member reads `presence: "offline"` with no identity fields — the same verdict a composed presence registry with no live heartbeats produces.

## Rendering

The Native renderer preserves the compact JSON shape of the canonical value. No custom UI presenters are declared: a roster is plain data, so the generic card (title = tool name, raw arguments) is the intended render intent.

## Role

This is the Consumer package for the project-membership seam's read face. It owns no permission decision: querying is unrestricted by role, and the membership service keeps enforcing that the reading account holds an active membership. Its stable errors exist so the model can branch — tell the user to sign in, or to link the workspace — instead of retrying.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`project_members` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-project-members): one optional `projectId` string and the array output contract.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The call arguments stay small — usually empty. Success returns compact JSON in the exact shape `[{"accountId":"…","displayName":"…","avatarRef":"…","role":"owner|admin|member","tags":["…"],"presence":"online|offline"}]`; `displayName` and `avatarRef` are omitted when the composition resolves no identities, and `presence` reads `offline` under the same condition. Stable failures are pinned verbatim: `Error: PROJECT_UNBOUND: no cloud project is bound to this workspace; link the workspace to a project or pass projectId explicitly` and `Error: ACCOUNT_UNAVAILABLE: no account is bound to the current session; sign in before querying project members`. Membership-service rejections (for example `NOT_A_MEMBER`, `PROJECT_NOT_FOUND`) surface through the same error channel with their stable codes.

#### Token effect

Result growth scales with the member count of the queried roster, and those tokens are retained until compaction. The schema and arguments are small and fixed-shape.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Presence and display identity need the platform provider face** — a composition without an injected `rosterPresenter` reports every member `offline` with no identity fields. Desktop Host supplies that presenter through the token-protected loopback projection.
- **Read-only by design** — the tool exposes no membership mutations; invitations, role changes, and tag edits stay behind the project-membership HTTP surface and out of the model's toolset.
- **The workspace binding is composition-defined** — the tool cannot resolve a bound project on its own; without an injected `boundProjectResolver` every omitted-`projectId` call answers `PROJECT_UNBOUND`.
