# 项目成员

[English](project-membership.md) | 中文

[`ctx.projectMembership`](../../packages/platform/project-membership/README.zh.md) 是工作区之上的协作平面:云端项目将规范化后的 git remote 作为已验证属性绑定,成员只携带 `owner|admin|member` 三种角色与永不承载权限的项目自定义功能标签,邀请沿 `pending → accepted | declined | retracted` 流转,并携带接受并关联工作区时授予的角色。owner 可邀请为 `admin` 或 `member`;admin 只能邀请为 `member`。接受与链接唯一本地工作区原子提交;对已持有成员身份或待决邀请的账户重复邀请会在并发下被原子拒绝。

每次变更的角色门都在操作内部执行:管理员可邀请但不能触碰 owner 行、不能移除 owner;只有 owner 能授予 owner 角色;最后一名 owner 不可降级或移除(`LAST_OWNER`)。读取同样有门——`roster` 要求有效成员身份,被移除账户即刻丧失枚举能力。每次影响 roster 的提交都会在落盘之后发布一条 [`project-membership/roster-invalidated`](#cordis-surface) 事件,使项目级投影版本前进,供缓存消费方作键。

[`@deepseek-ai/dsh-project-membership-core`](../../packages/platform/project-membership-core/README.zh.md) 是文件持久化 Provider:状态按环境命名空间(`development`/`production`)存放于所配置存储路径之下,每次变更经单一写链串行化并整体原子重命名发布。角色只治理本协作层面,与 Git 平台权限双向无关。成员提问路由保持 fail-closed,仍受[放置决策 Agent Note](../../.agents/notes/implemented/feature/2026-08-27-project-membership-core.zh.md) 记录的常设加密评审约束。

Presence 是 Desktop Installation 的实时连接，由 [HTTP Consumer](../../packages/platform/project-membership-http/README.zh.md) 与 [Desktop Host](../../apps/desktop/README.zh.md) 拥有：关闭最后一个窗口会 POST `/v1/projects/presence/close`，花名册读者立即看到 Offline，TTL 过期仍是崩溃与分区路径，对离线成员的路由提问以 `MEMBER_OFFLINE` 快速失败且不写入任何队列。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdesktopprojectmembership--desktopprojectmembershipservice"></a>

### `ctx.desktopProjectMembership` — `DesktopProjectMembershipService`

Client-side Service Provider over the Desktop Host's token-protected loopback projection.

```ts cordis-catalog
/**
 * Resolve the signed-in Account and the current session Workspace's optional Cloud Project.
 * @param agent - live Agent whose immutable session cwd selects the Workspace.
 * @param signal - optional cancellation for the loopback read.
 * @returns current Desktop context, or no value for diagnostics without a cwd.
 */
async context(agent?: Agent, signal?: AbortSignal): Promise<DesktopProjectMembershipContext | undefined>

/**
 * Read the current signed-in Desktop Account independently of any Workspace.
 * @param signal - optional cancellation for the loopback read.
 * @returns current public Account identity.
 * @throws when Desktop has no signed-in Account or the bridge response is invalid.
 */
async currentAccount(signal?: AbortSignal): Promise<DesktopProjectMembershipContext['account']>

/**
 * Read one complete authoritative roster and retain its identity/presence decorations for the presenter.
 * @param actor - current Desktop Account id.
 * @param projectId - Cloud Project to read.
 * @param signal - optional cancellation for the loopback read.
 * @returns canonical stored roster fields.
 * @throws when the actor differs from Desktop Account or the roster response is invalid.
 */
async roster(actor: PlatformAccountId, projectId: ProjectId, signal?: AbortSignal): Promise<RosterView>

/**
 * Project the decorations retained by the exact roster read.
 * @param view - roster returned by {@link roster}.
 * @returns one presentation per member in stored order.
 * @throws when `view` was not returned by this service instance.
 */
present(view: RosterView): Promise<readonly DesktopMemberPresentation[]>

/**
 * Resolve one member-question route from the current bound-Project roster.
 * @param agent - live asking Agent.
 * @param addresseeLogin - public GitHub login from `to_project_member`.
 * @param originSessionTitle - latest public Session title, or the product fallback.
 * @param signal - optional cancellation for both route-authority reads.
 * @returns authenticated Project, matched Account, and origin, or no value when the login is not a current member.
 * @throws when the Workspace is unbound or the current Account is absent from the roster.
 */
async questionRoute( agent: Agent | undefined, addresseeLogin: string, originSessionTitle: string, signal?: AbortSignal, ): Promise<DesktopMemberQuestionRoute | undefined>
```

Types: [Agent](core.zh.md) · [PlatformAccountId](platform-account.zh.md)

Source: [`packages/platform/project-membership-desktop/src/index.ts`](../../packages/platform/project-membership-desktop/src/index.ts)

<a id="ctxprojectmembership--projectmembershipservice-abstract-seam"></a>

### `ctx.projectMembership` — `ProjectMembershipService` (abstract seam)

Project-membership capability. Every mutation executes its role gate inside the operation itself: schema omission or listener order never substitutes for the check that decides the outcome.

```ts cordis-catalog
/**
 * Create one project; the actor becomes its first owner.
 * @param actor - authenticated account performing the mutation.
 * @param input - unique project name and git remote to bind.
 * @returns the stored project view.
 * @throws {ProjectMembershipError} `PROJECT_NAME_TAKEN` when the name is in use,
 * `PROJECT_REMOTE_TAKEN` when another Project owns the normalized remote,
 * or `INVALID_REMOTE_URL` when normalization fails.
 */
abstract createProject(actor: PlatformAccountId, input: CreateProjectInput): Promise<ProjectView>

/**
 * Issue one invitation to a platform account.
 * @param actor - authenticated account holding admin or owner on the project.
 * @param input - target project, invitee account, and the role granted at accept time.
 * @returns the invitation in `pending` state, carrying that granted role.
 * @throws {ProjectMembershipError} `ROLE_REQUIRED` below admin or when the actor cannot grant the requested role,
 *   `DUPLICATE_INVITEE` when the account already holds membership or a pending invitation, or `NOT_A_MEMBER`
 *   when the actor holds no membership.
 */
abstract invite(actor: PlatformAccountId, input: InviteInput): Promise<InvitationView>

/**
 * Retract one invitation issued by the caller while it is still pending.
 * @param actor - authenticated account; must be the invitation's issuer or an owner of the project.
 * @param invitationId - invitation to retract.
 * @returns nothing; the stored state moves to `retracted`.
 * @throws {ProjectMembershipError} `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, or `ROLE_REQUIRED`.
 */
abstract retractInvitation(actor: PlatformAccountId, invitationId: InvitationId): Promise<void>

/**
 * Accept one pending invitation; joining and workspace linking commit atomically, so no joined-but-unlinked state can exist.
 * @param actor - authenticated account; must be the invitation's addressee.
 * @param input - invitation id plus the mandatory workspace link.
 * @returns the created member view.
 * @throws {ProjectMembershipError} `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, `DUPLICATE_INVITEE`, or
 *   `INVALID_LINK` when the link omits a workspace name.
 */
abstract acceptInvitation(actor: PlatformAccountId, input: AcceptInvitationInput): Promise<MemberView>

/**
 * Decline one pending invitation addressed to the caller.
 * @param actor - authenticated account; must be the invitation's addressee.
 * @param invitationId - invitation to decline.
 * @returns nothing; the stored state moves to `declined`.
 * @throws {ProjectMembershipError} `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, or `ROLE_REQUIRED`.
 */
abstract declineInvitation(actor: PlatformAccountId, invitationId: InvitationId): Promise<void>

/**
 * Change one membership's role. Rows whose current or target role is owner answer only to owners; admins may move
 * members between `member` and `admin`.
 * @param actor - authenticated account holding admin or owner.
 * @param input - membership row and new role.
 * @returns nothing; the stored row carries the new role.
 * @throws {ProjectMembershipError} `MEMBERSHIP_NOT_FOUND`, `ROLE_REQUIRED`, or `LAST_OWNER` when demoting the final owner.
 */
abstract changeRole(actor: PlatformAccountId, input: ChangeRoleInput): Promise<void>

/**
 * Replace one membership's project-defined function tags; tags are display and routing metadata and never gate permissions.
 * @param actor - authenticated account holding admin or owner.
 * @param input - membership row and replacement tags.
 * @returns nothing; the stored row carries the new tags.
 * @throws {ProjectMembershipError} `MEMBERSHIP_NOT_FOUND` or `ROLE_REQUIRED`.
 */
abstract setMemberTags(actor: PlatformAccountId, input: SetMemberTagsInput): Promise<void>

/**
 * Remove one membership. Removing an owner answers only to owners; when members remain after removal, every cached
 * roster projection for the project is invalidated by the same operation.
 * @param actor - authenticated account holding admin or owner.
 * @param membershipId - membership row to remove.
 * @returns nothing.
 * @throws {ProjectMembershipError} `MEMBERSHIP_NOT_FOUND`, `ROLE_REQUIRED`, or `LAST_OWNER` when removing the final owner.
 */
abstract removeMember(actor: PlatformAccountId, membershipId: MembershipId): Promise<void>

/**
 * Read one project's full roster; both caller and readers require an active membership, so removed accounts lose enumeration immediately.
 * @param actor - authenticated account whose active membership gates the read.
 * @param projectId - project to project.
 * @returns the roster view derived from current authority, not a stale cache.
 * @throws {ProjectMembershipError} `PROJECT_NOT_FOUND` or `NOT_A_MEMBER`.
 */
abstract roster(actor: PlatformAccountId, projectId: ProjectId): Promise<RosterView>

/**
 * List invitations addressed to the caller that still await a decision.
 * @param actor - authenticated account.
 * @returns pending invitations in issuance order.
 */
abstract pendingInvitationsFor(actor: PlatformAccountId): Promise<readonly InvitationView[]>

/**
 * List pending invitations issued for one Project after an admin-or-owner gate.
 * @param actor - authenticated Project administrator.
 * @param projectId - Project whose pending invitations are requested.
 * @returns pending invitations in issuance order.
 */
abstract pendingInvitationsIssuedBy( actor: PlatformAccountId, projectId: ProjectId, ): Promise<readonly InvitationView[]>

/**
 * List pending invitations with their authoritative project name and remote.
 * @param actor - authenticated invitee account.
 * @returns pending invitation/project pairs in issuance order.
 */
abstract pendingInvitationContextsFor(actor: PlatformAccountId): Promise<readonly PendingInvitationContext[]>

/**
 * Find the project bound to a normalized git remote, if the actor holds a membership there.
 * @param actor - authenticated account whose memberships scope the search.
 * @param normalizedRemoteUrl - normalized remote URL recorded at creation.
 * @returns the project view, or undefined when no such membership exists.
 */
abstract projectByRemote(actor: PlatformAccountId, normalizedRemoteUrl: string): Promise<ProjectView | undefined>

/**
 * Read one project's current roster projection version. Consumers key caches
 * on it; every committed membership-set or role-or-tag mutation publishes a
 * new strictly increasing value for that project.
 * @param projectId - project to read.
 * @returns the project's roster projection version.
 * @throws {ProjectMembershipError} `PROJECT_NOT_FOUND`.
 */
abstract rosterVersion(projectId: ProjectId): Promise<number>
```

Types: [PlatformAccountId](platform-account.zh.md)

Source: [`packages/platform/project-membership/src/index.ts`](../../packages/platform/project-membership/src/index.ts)

<a id="ctxprojectmembershipclient--projectmembershipclient"></a>

### `ctx.projectMembershipClient` — `ProjectMembershipClient`

Authenticated current-installation client used by product UI consumers.

```ts cordis-catalog
/**
 * Create one Cloud Project for a Workspace remote.
 * @param input - unique name and Workspace remote.
 * @returns created Cloud Project.
 */
createProject(input: { name: string; remoteUrl: string }): Promise<AuthenticatedProjectView>

/**
 * Resolve the current Account's Project membership for one normalized Git remote.
 * @param normalizedRemoteUrl - canonical Workspace origin remote.
 * @returns authorized Project context, or no value when this Account has no membership.
 */
projectByRemote(normalizedRemoteUrl: string): Promise<AuthenticatedProjectView | undefined>

/**
 * Read one Project roster with public identity and presence.
 * @param projectId - Project to read.
 * @returns Project and complete decorated roster.
 */
roster(projectId: ProjectId): Promise<RosterReadView>

/**
 * Refresh this Desktop Installation's live presence heartbeat.
 * @returns fulfillment after Platform records the beat.
 */
heartbeat(): Promise<void>

/**
 * Clear this Desktop Installation immediately so roster readers see Offline
 * without waiting for presence TTL.
 * @returns fulfillment after Platform drops this installation.
 */
closePresence(): Promise<void>

/**
 * Invite one uniquely resolved public GitHub login.
 * @param input - Project, public GitHub login, and the role granted at accept time.
 * @returns created pending invitation carrying that granted role.
 */
invite(input: { projectId: ProjectId; githubLogin: string; grantedRole: ProjectRole }): Promise<InvitationView>

/**
 * Decline, or accept atomically with a local Workspace link.
 * @param invitationId - invitation to decide.
 * @param input - decline or linked acceptance.
 * @returns accepted member, or no value for decline.
 */
decideInvitation(invitationId: InvitationId, input: InvitationDecisionInput): Promise<MemberView | undefined>

/**
 * Retract one pending invitation as its Project administrator.
 * @param invitationId - pending invitation to retract.
 */
retractInvitation(invitationId: InvitationId): Promise<void>

/**
 * List trusted pending invitation cards for the current Account.
 * @returns trusted pending invitation cards.
 */
pendingInvitations(): Promise<readonly PendingInvitationView[]>

/**
 * List pending invitations issued from one administered Project.
 * @param projectId - Project whose issued invitations are requested.
 * @returns authoritative pending invitation rows.
 */
issuedInvitations(projectId: ProjectId): Promise<readonly IssuedInvitationView[]>

/**
 * Replace one member's collaboration role.
 * @param membershipId - membership to change.
 * @param role - replacement collaboration role.
 */
changeRole(membershipId: MembershipId, role: ProjectRole): Promise<void>

/**
 * Replace one member's non-permission function tags.
 * @param membershipId - membership to relabel.
 * @param tags - complete replacement function tags.
 */
setMemberTags(membershipId: MembershipId, tags: readonly FunctionTag[]): Promise<void>

/**
 * Remove one member from the Project.
 * @param membershipId - membership to remove.
 */
removeMember(membershipId: MembershipId): Promise<void>
```

Source: [`packages/platform/project-membership-client/src/index.ts`](../../packages/platform/project-membership-client/src/index.ts)

<a id="project-membership-events"></a>

### `project-membership/*` events

<a id="project-membershiproster-invalidated--emit"></a>

#### `project-membership/roster-invalidated` — emit

A membership mutation committed durably and its project's roster view must be re-derived. One event per commit in write order.

```ts cordis-catalog
/**
 * A membership mutation committed durably and its project's roster view
 * must be re-derived. One event per commit in write order.
 * @param change - project, membership, account, both roster versions, and the change discriminant with any post-state payload.
 * @mode emit
 */
'project-membership/roster-invalidated'(change: RosterInvalidation): void
```

Source: [`packages/platform/project-membership/src/events.ts`](../../packages/platform/project-membership/src/events.ts)
<!-- END GENERATED cordis-surface -->
