# 个人配对

[English](personal-pairing.md) | 中文

[`@deepseek-ai/dsh-remote-access`](../../packages/platform/remote-access/README.md) 拥有手机访问开关、配对挑战消费、待确认握手确认、个人配对身份与仅限 Companion 的设备主体权限。它调用 `ctx.platformAccount.currentInstallation()` 鉴别每个账号会话的安装 id 与类型，再比较不透明的平台账号 id；它从不读取账号存储或 GitHub 字段，也不信任调用方自行提供的安装身份。

## 挑战与确认生命周期

每个 Desktop 安装的手机访问都默认为关闭，直到 Desktop 设置所有者开启。已开启的 Desktop 创建一项挑战，其中包含 32 字节邀请能力、Desktop 指纹、rendezvous id、两分钟过期时间与协议主版本。QR 与完整链接展示编码同一个 HTTPS 值。不存在短码解析器或回退路径。

Mobile 仅在完整链接与保留能力相符后消费邀请。跨账号尝试会在密码适配器运行前销毁邀请。有效的同账号握手生成待确认密钥与握手哈希；六个派生认证词会出现在两个安装上，但活跃配对列表在 Desktop 确认前保持为空。确认会激活唯一且由提供方拥有的密钥引用，并授予带品牌的设备主体，其权限严格等于 `companion-surface`。

变更串行执行。过期、取消、拒绝、关闭手机访问与一次成功完成都会先提交终态，使另一项变更无法再观察该能力。组合了推送存储时，`registerPushToken` 接受 `PushTokenRegistration`，`publishPushHint` 返回 `CompanionPushReport`，单独撤销会删除该 Mobile 安装在 Desktop route 上的 token，关闭手机访问会删除被撤销 route 上的全部 token。密码资源销毁可以独立重试：清理失败不会重复完成握手或激活配对，提供方释放资源时会尝试处理每项挑战、待确认密钥、活跃密钥与清理记录。挑战创建时就调度过期任务，不会等待另一项完成请求。不透明生成 id 与已激活密钥引用都会在插入前判重，因此碰撞不能覆盖既有记录，也不能遗弃新分配的密钥。

## 密码适配器

`PairingHandshakeProvider` 准备、完成、激活并销毁提供方私有握手状态。远程访问从不实现 Noise 状态迁移或密码原语。`remote-access-http` 消费 `ctx.remoteAccess`，`remote-access-client` 则校验真实 Desktop 设置与 Mobile 控制器使用的协议值。组装后的 loader 场景使用 `DevelopmentKeylessPairingHandshakeProvider`，让提供方、HTTP 消费方和共享传输通过真实环回服务器运行。[`examples/local-companion-platform`](../../examples/local-companion-platform/README.md) 把同一适配器保持在长期运行的双实例 TLS origin 上，供本地 Desktop 与 Mobile 客户端使用。Desktop 与 Mobile 开发入口只能通过显式标志选择各自的真实控制器。生产组合在独立 Noise 评审接纳经过评审的提供方前保持不可用；开发证明永远不会由生产路径选择。

## 多实例 Relay

`ctx.remoteRelay` 使用不透明 route id 与独立可轮换的 32 字节凭据鉴权 attachment，通过 `RelayRouteStore` 只持久化其 digest 与 revision，并将在线 attachment 注册到会过期的共享目录。`remote-access-redis` 只承载目录元数据、不含内容的失效通知与有界密文 Pub/Sub；它不创建离线 queue。位于另一 Platform Instance 的目标会收到同一个不透明 Relay frame，目标缺失则立即返回 `REMOTE_OFFLINE`。

Mobile 与 Desktop 通过一个 non-sticky TLS endpoint 向外连接。实例丢失会建立新连接；Desktop 在 attachment 后发送权威加密 projection，不迁移在线 socket。关闭 Desktop 窗口会退出进程，sleep、quit、退出账号或关闭手机访问都会停止 Relay。在组装经过评审的产品密码学能力前，生产保持 fail-closed。无 Noise 握手 / SHA-256 开发派生双实例 Loader 场景只证明 transport 组合，不会削弱该 gate。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremoteaccess--remoteaccessservice-abstract-seam"></a>

### `ctx.remoteAccess` — `RemoteAccessService` (abstract seam)

Remote Access capability owning the complete Personal Pairing lifecycle.

```ts cordis-catalog
/**
 * Create one two-minute invitation for a signed-in Desktop Installation.
 * @param input - Desktop authorization, opaque rendezvous identity, and the client IP counted toward the hourly IP quota.
 * @returns complete QR/link projection; no low-entropy fallback exists.
 * @throws RemoteAccessError `QUOTA` or `PLATFORM_CAPACITY` with `retryAfter` seconds.
 * @throws TypeError when `clientIp` is empty.
 */
abstract createChallenge(input: { desktop: PairingAccountAuthentication rendezvousId: PairingRendezvousId clientIp: string }): Promise<PairingChallengeView>

/**
 * Read the current Desktop Installation's Mobile Access state.
 * @param desktop - current Desktop authorization.
 * @returns whether Settings has enabled Mobile Access for this Installation.
 */
abstract getMobileAccessState(desktop: PairingAccountAuthentication): Promise<MobileAccessState>

/**
 * Set Mobile Access from the Desktop Settings owner.
 * @param input - current Desktop authorization and requested state.
 * @returns committed Mobile Access state.
 */
abstract setMobileAccess(input: { desktop: PairingAccountAuthentication enabled: boolean }): Promise<MobileAccessState>

/**
 * Rotate and return fresh Desktop-only Relay authority after process startup or window reopen.
 * @param desktop - current Desktop authorization for an enabled installation.
 * @returns enabled state carrying a fresh Desktop grant.
 */
abstract reissueDesktopRelayAuthority(desktop: PairingAccountAuthentication): Promise<MobileAccessState>

/**
 * Complete the same-account cryptographic exchange without granting authority.
 * @param input - Mobile authorization, invitation, device metadata, and handshake bytes.
 * @returns pending result shown on both installations before Desktop confirmation.
 */
abstract completeChallenge(input: { mobile: PairingAccountAuthentication completionId: PairingCompletionId oneTimeLink: string device: PairingDeviceDescription mobileHandshake: Uint8Array }): Promise<PairingCompletionView>

/**
 * Read the decision for one pairing completed by the current Mobile Installation.
 * @param input - current Mobile authorization and pending identity.
 * @returns pending, paired, or rejected without exposing Desktop authority.
 */
abstract getMobilePairingStatus(input: { mobile: PairingAccountAuthentication pendingPairingId: PendingPairingId }): Promise<MobilePairingStatus>

/**
 * List active pairings visible to one signed-in Desktop Account.
 * @param desktop - current Desktop Account authorization.
 * @returns only confirmed pairings; pending handshakes are excluded.
 */
abstract listPersonalPairings(desktop: PairingAccountAuthentication): Promise<readonly PersonalPairingView[]>

/**
 * Revoke one confirmed pairing: destroy its key, drop Mobile Relay authority, and close live attachments.
 * @param input - Desktop authorization and pairing identity.
 */
abstract revokePersonalPairing(input: { desktop: PairingAccountAuthentication pairingId: PersonalPairingId }): Promise<void>

/**
 * List completed handshakes awaiting this Desktop Installation's decision.
 * @param desktop - current Desktop authorization.
 * @returns pending handshakes owned by this Desktop Installation.
 */
abstract listPendingPairings(desktop: PairingAccountAuthentication): Promise<readonly PairingCompletionView[]>

/**
 * Activate one pending pairing after the Desktop user compares authentication words.
 * Rejected at the fifty-first live Personal Pairing for the Account, before handshake activation.
 * @param input - confirming Desktop and pending identity.
 * @returns independently keyed Companion-only Device Principal.
 * @throws RemoteAccessError `QUOTA` with a 60-second `retryAfter` when the Account pairing ceiling is full.
 */
abstract confirmPairing(input: { desktop: PairingAccountAuthentication pendingPairingId: PendingPairingId }): Promise<PersonalPairingView>

/**
 * Cancel one active invitation; repeated cancellation is a no-op.
 * @param input - owning Desktop authorization and challenge identity.
 */
abstract cancelChallenge(input: { desktop: PairingAccountAuthentication challengeId: PairingChallengeId }): Promise<void>

/**
 * Reject one pending handshake; repeated rejection is a no-op.
 * @param input - owning Desktop authorization and pending identity.
 */
abstract rejectPairing(input: { desktop: PairingAccountAuthentication pendingPairingId: PendingPairingId }): Promise<void>

/**
 * Bind one device push token to the Mobile Installation's confirmed pairing route.
 * @param input - Mobile authorization and the registration.
 */
abstract registerPushToken(input: { mobile: PairingAccountAuthentication registration: PushTokenRegistration }): Promise<void>

/**
 * Drop exactly one device push token, as on Mobile unpair.
 * @param input - Mobile authorization, route, and exact token.
 */
abstract unregisterPushToken(input: { mobile: PairingAccountAuthentication routeId: RelayRouteId token: CompanionPushToken }): Promise<void>

/**
 * Fan one Desktop-confirmed content-free hint out to the route's live tokens.
 * @param input - Desktop authorization and the generic hint.
 * @returns delivery and pruning counts.
 */
abstract publishPushHint(input: { desktop: PairingAccountAuthentication hint: CompanionPushHint }): Promise<CompanionPushReport>

/**
 * Reserve one expiring ciphertext blob against the open-registration ceilings.
 * @param input - current-installation authorization and declared ciphertext size.
 * @returns opaque reservation id released by {@link releaseAttachmentBlob}.
 * @throws RemoteAccessError `QUOTA` or `PLATFORM_CAPACITY` with `retryAfter` seconds.
 * @throws TypeError when `bytes` is not a non-negative integer.
 */
abstract admitAttachmentBlob(input: { owner: PairingAccountAuthentication bytes: number }): Promise<{ reservationId: string }>

/**
 * Release one blob reservation after receipt, expiry, or revocation.
 * @param input - current-installation authorization and reservation id.
 * @throws TypeError when the reservation is missing or owned by another Account.
 */
abstract releaseAttachmentBlob(input: { owner: PairingAccountAuthentication reservationId: string }): Promise<void>

/**
 * Admit one content-free push hint against the daily account ceiling.
 * Capacity shedding does not reject push hints.
 * @param owner - current-installation authorization.
 * @throws RemoteAccessError `QUOTA` with remaining-window `retryAfter` seconds.
 */
abstract emitPushHint(owner: PairingAccountAuthentication): Promise<void>
```

Types: [CompanionPushHint](remote-protocol.md) · [CompanionPushToken](remote-protocol.md)

Source: [`packages/platform/remote-access/src/index.ts:449`](../../packages/platform/remote-access/src/index.ts)

<a id="ctxremoteattachmentauthority--remoteattachmentauthority"></a>

### `ctx.remoteAttachmentAuthority` — `RemoteAttachmentAuthority`

Pairing scope seam: the Personal Pairing layer authenticates one HTTPS request to exactly one Personal Pairing. Implementations never see attachment bytes.

```ts cordis-catalog
/**
 * Authenticate one attachment request to its owning Personal Pairing.
 * @param input - complete untrusted request headers.
 * @returns the Personal Pairing whose scope governs the capability.
 */
authenticate(input: { headers: IncomingHttpHeaders }): Promise<PersonalPairingId>
```

Source: [`packages/platform/remote-attachments/src/http.ts:29`](../../packages/platform/remote-attachments/src/http.ts)

<a id="ctxremoteattachments--remoteattachmentstoreservice-abstract-seam"></a>

### `ctx.remoteAttachments` — `RemoteAttachmentStoreService` (abstract seam)

Platform attachment blob store: retains ciphertext and metadata only, bounded per blob and in total, scoped to exactly one Personal Pairing, single-use, and expiring.

```ts cordis-catalog
/**
 * Retain one pairing-scoped ciphertext blob and issue its one-time capability.
 * @param input - owning Personal Pairing, endpoint-encrypted ciphertext, and current time.
 * @returns the capability grant Mobile forwards to Desktop.
 */
abstract publish(input: { pairingId: PersonalPairingId; ciphertext: Uint8Array; now: number }): Promise<RemoteAttachmentGrant>

/**
 * Return a copy of one retained ciphertext without consuming the capability.
 * @param input - requesting Personal Pairing, one-time capability, and current time.
 * @returns a copy of the retained ciphertext bytes.
 */
abstract inspect(input: { pairingId: PersonalPairingId; capability: AttachmentCapability; now: number }): Promise<Uint8Array>

/**
 * Exchange one capability for its ciphertext exactly once, then remove both.
 * @param input - requesting Personal Pairing, one-time capability, and current time.
 * @returns a copy of the retained ciphertext bytes.
 */
abstract consume(input: { pairingId: PersonalPairingId; capability: AttachmentCapability; now: number }): Promise<Uint8Array>

/**
 * Remove one blob and its capability regardless of remaining lifetime.
 * @param input - owning Personal Pairing and the capability whose blob is revoked.
 * A pairing mismatch fails explicitly; an unknown capability is a no-op.
 */
abstract revoke(input: { pairingId: PersonalPairingId; capability: AttachmentCapability }): Promise<void>

/**
 * Project every retained blob for Platform-side operations.
 * @returns copies of ciphertext and metadata only; no plaintext exists on this side of the boundary.
 */
abstract observe(): readonly RemoteAttachmentBlob[]
```

Source: [`packages/platform/remote-attachments/src/index.ts:59`](../../packages/platform/remote-attachments/src/index.ts)

<a id="ctxremoterelay--remoterelayservice-abstract-seam"></a>

### `ctx.remoteRelay` — `RemoteRelayService` (abstract seam)

Public Remote Access Relay capability used by the WSS Consumer.

```ts cordis-catalog
/**
 * Rotate one route to fresh authority and invalidate older attachments.
 * @param routeId - opaque route receiving new attachment authority.
 * @param endpoint - endpoint whose same-endpoint credentials the rotation replaces; defaults to desktop.
 * @returns the one-time credential grant and its persistent revision.
 */
abstract rotateCredential(routeId: RelayRouteId, endpoint?: 'mobile' | 'desktop'): Promise<RelayCredentialGrant>

/**
 * Issue distinct endpoint authority without invalidating other credentials on the active route.
 * @param routeId - active route receiving another independently revocable bearer.
 * @param endpoint - endpoint the new credential authorizes; defaults to mobile.
 * @returns a fresh credential at the current route revision.
 */
abstract issueCredential(routeId: RelayRouteId, endpoint?: 'mobile' | 'desktop'): Promise<RelayCredentialGrant>

/**
 * Remove one issued endpoint credential without revoking its route peers.
 * @param grant - exact issued authority whose ownership did not commit.
 */
abstract revokeCredential(grant: RelayCredentialGrant): Promise<void>

/**
 * Revoke one route and close its attachments across Platform Instances.
 * @param routeId - opaque route whose current authority becomes invalid.
 */
abstract revokeRoute(routeId: RelayRouteId): Promise<void>

/**
 * Authenticate one outbound Mobile or Desktop attachment and register it only after `announce` flushes ready.
 * @param input - attach frame, socket writer, optional close callback, and optional ready flush.
 * @returns the admitted attachment receiving later frames from that socket.
 */
abstract attach(input: { message: RelayAttachMessage deliver: (message: RelayCiphertextMessage) => Promise<void> close?: () => void | Promise<void> signal?: AbortSignal announce?: () => Promise<void> }): Promise<RemoteRelayAttachment>
```

Source: [`packages/platform/remote-access/src/relay.ts:143`](../../packages/platform/remote-access/src/relay.ts)
<!-- END GENERATED cordis-surface -->
