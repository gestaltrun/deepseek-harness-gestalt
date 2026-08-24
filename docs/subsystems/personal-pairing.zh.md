# 个人配对

[English](personal-pairing.md) | 中文

[`@deepseek-ai/dsh-remote-access`](../../packages/platform/remote-access/README.zh.md) 拥有 Mobile Access 开关、Pairing Challenge 消费、待确认握手确认、Personal Pairing 身份与仅限 Companion 的 Device Principal authority。它调用 `ctx.platformAccount.currentInstallation()` 鉴别每个 Account Session 的 Installation id、类型与 Mobile 展示，再比较不透明的 Platform Account id。配对完成不接受设备字段：待确认与已确认记录只使用已鉴别 Mobile Installation 展示。

## 挑战与确认生命周期

每个 Desktop 安装的手机访问都默认为关闭，直到 Desktop 设置所有者开启。Platform 只分配不透明且两分钟过期的路由挑战；Desktop 随后在本地创建并保留 XKpsk3 邀请 PSK，展示完整 QR 或 HTTPS 链接。Platform 不接收邀请载荷或端点私有状态。不存在短码解析器或回退路径。

同账号端点 mailbox 把 message 1 绑定到保留的路由挑战后，Mobile 才消费邀请。Desktop 与 Mobile 通过 Platform 交换不透明 XKpsk3 消息，比较由本地 transcript 派生的六个认证词，并在 Desktop 确认前保持待确认。两个端点分别生成自己的 P-256 Relay 签名凭据；Platform 在新 pairing selector 下原子登记不同的公钥摘要，并授予带品牌的设备主体，其权限严格等于 `companion-surface`。

变更串行执行。过期、取消、拒绝、关闭手机访问与一次成功完成都会先提交终态，使另一项变更无法再观察该能力。完成重放要求已鉴别账号、Mobile Installation、全部邀请字段与 Mobile 握手字节的定长 digest 相符；同一完成 id 下任一内容变化都属于碰撞。配对事务格式版本 1 记录这项 digest 要求。无版本文档会保留已确认配对与受 digest 约束的重放记录；缺少 digest 的完成或待确认记录会转为终态清理记录，不能重放。系统拒绝未知的显式版本与格式错误的带版本文档。密码资源销毁可以独立重试：清理失败不会重复完成握手或激活配对，提供方释放资源时会尝试处理每项挑战、待确认密钥、活跃密钥与清理记录。挑战创建时就调度过期任务，不会等待另一项完成请求。不透明生成 id 与已激活密钥引用都会在插入前判重，因此碰撞不能覆盖既有记录，也不能遗弃新分配的密钥。

## 密码适配器

产品入口把 Snow 配对与重连状态分别保存在 Desktop safeStorage 和 Mobile IndexedDB。`PairingHandshakeProvider` 只留给有界 keyless 测试；Platform 产品组合拒绝对该适配器的任何调用。`remote-access-http` 承载不透明 mailbox 消息、仅摘要确认和密封 Relay authority，`remote-access-client` 拥有 attachment challenge proof 与端点生命周期。Desktop 在 sleep、关闭窗口与进程重启之间保留加密 vault，只在账号范围重置、关闭手机访问或撤销配对时擦除。

## 多实例 Relay

`ctx.remoteRelay` 使用一次性 P-256 challenge proof 鉴权每个新 attachment；proof 绑定 route、端点、pairing selector、attachment id、公钥、nonce 与过期时间。`RelayRouteStore` 只持久化唯一公钥摘要、selector、单调 revision 与撤销状态。Mobile presence 为每个已鉴别连接 token 保存一条过期 lease；精确 token close 无法清除另一实例的在线 attachment，缺失清理也会在 lease 到期后转为离线。`lastAccessAt` 只在已鉴别 attach、heartbeat 或 ciphertext 访问时推进。`remote-access-redis` 只承载目录元数据、不含内容的失效通知与有界密文 Pub/Sub；它不创建离线 queue。位于另一 Platform Instance 的目标会收到同一个不透明 Relay frame，目标缺失则立即返回 `REMOTE_OFFLINE`。

Mobile 与 Desktop 通过一个 non-sticky TLS endpoint 向外连接。实例丢失会建立新连接与 Snow IK generation；Desktop 在 attachment 后发送已认证的前台同步，不迁移在线 socket。组装测试启动两套由独立 Loader 持有的 Platform／WebServer／HTTP composition，经 non-sticky endpoint 到达各自发布的 WSS upgrade handler，确认两台密钥独立的手机，并证明撤销一项配对后另一项仍可使用。其中的内存存储与 localhost 证书是确定性测试适配器，不是已运营环境验收；物理 WebView 证据和独立评审仍是 release blocker。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

/** Allocate routing metadata before Desktop constructs its endpoint-owned invitation.
 * @param input - Desktop authorization, rendezvous identity, expiry, and client quota identity.
 * @returns challenge identity and routing link containing no invitation payload.
 */
abstract createEndpointChallenge(input: { desktop: PairingAccountAuthentication rendezvousId: PairingRendezvousId clientIp: string expiresAt: number }): Promise<EndpointPairingChallengeView>

/** Cancel one unused endpoint-owned invitation.
 * @param input - authenticated Desktop ownership and challenge identity.
 */
abstract cancelEndpointChallenge(input: { desktop: PairingAccountAuthentication challengeId: PairingChallengeId }): Promise<void>

/** Submit Mobile XKpsk3 message 1 to the authenticated Desktop mailbox.
 * @param input - Mobile authorization, challenge/completion identities, and opaque message.
 * @returns stable pending identity.
 */
abstract submitEndpointMessage1(input: { mobile: PairingAccountAuthentication challengeId: PairingChallengeId completionId: PairingCompletionId message1: Uint8Array }): Promise<{ pendingPairingId: PendingPairingId }>

/** Read endpoint-owned pending work for this Desktop.
 * @param desktop - authenticated Desktop installation.
 * @returns opaque message 1/3 projections.
 */
abstract listEndpointPending(desktop: PairingAccountAuthentication): Promise<readonly EndpointPairingDesktopView[]>

/** Submit Desktop XKpsk3 message 2.
 * @param input - Desktop ownership, pending identity, and opaque response.
 */
abstract submitEndpointMessage2(input: { desktop: PairingAccountAuthentication pendingPairingId: PendingPairingId message2: Uint8Array }): Promise<void>

/** Read Mobile mailbox progress by idempotency identity.
 * @param input - Mobile ownership and completion identity.
 * @returns current opaque mailbox stage.
 */
abstract getEndpointPairingStatus(input: { mobile: PairingAccountAuthentication completionId: PairingCompletionId }): Promise<EndpointPairingMobileView>

/** Submit Mobile XKpsk3 message 3.
 * @param input - Mobile ownership, completion identity, and opaque finish.
 */
abstract submitEndpointMessage3(input: { mobile: PairingAccountAuthentication completionId: PairingCompletionId message3: Uint8Array }): Promise<void>

/** Record that Desktop authenticated message 3 locally.
 * @param input - Desktop ownership and pending identity.
 * @returns confirmed pairing and digest-registered Relay route metadata.
 */
abstract confirmEndpointPairing(input: { desktop: PairingAccountAuthentication pendingPairingId: PendingPairingId desktopCredentialDigest: Uint8Array mobileCredentialDigest: Uint8Array }): Promise<EndpointPairingConfirmation>

/** Reject one endpoint-owned pending handshake.
 * @param input - authenticated Desktop ownership and pending identity.
 */
abstract rejectEndpointPairing(input: { desktop: PairingAccountAuthentication pendingPairingId: PendingPairingId }): Promise<void>

/** Forward Desktop-sealed Mobile Relay authority without opening it.
 * @param input - confirmed Desktop ownership and opaque transport ciphertext.
 */
abstract deliverEndpointRelayAuthority(input: { desktop: PairingAccountAuthentication pendingPairingId: PendingPairingId sealedRelayAuthority: Uint8Array }): Promise<void>

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
 * @param input - Mobile authorization, invitation, and handshake bytes.
 * @returns pending result shown on both installations before Desktop confirmation.
 */
abstract completeChallenge(input: { mobile: PairingAccountAuthentication completionId: PairingCompletionId oneTimeLink: string mobileHandshake: Uint8Array }): Promise<PairingCompletionView>

/**
 * Finish a three-message pairing handshake before Desktop confirmation.
 * @param input - Mobile authorization, pending identity, and message 3.
 * @returns the pending projection with final authentication words.
 */
finishChallenge(input: { mobile: PairingAccountAuthentication pendingPairingId: PendingPairingId mobileFinish: Uint8Array }): Promise<PairingCompletionView>

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
 * Revoke the confirmed pairing owned by its authenticated Mobile Installation.
 * @param input - Mobile authorization and retained pairing identity.
 */
abstract revokeMobilePersonalPairing(input: { mobile: PairingAccountAuthentication pairingId: PersonalPairingId }): Promise<void>

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
 * Reserve one expiring ciphertext blob against the open-registration ceilings.
 * @param input - current-installation authorization and declared ciphertext size.
 * @returns opaque reservation id plus its durable absolute lease expiry.
 * @throws RemoteAccessError `QUOTA` or `PLATFORM_CAPACITY` with `retryAfter` seconds.
 * @throws TypeError when `bytes` is not a non-negative integer.
 */
abstract admitAttachmentBlob(input: { owner: PairingAccountAuthentication bytes: number }): Promise<{ reservationId: AttachmentBlobReservationId; expiresAt: number }>

/**
 * Release one blob reservation after receipt, expiry, or revocation.
 * @param input - current-installation authorization and reservation id.
 * @throws TypeError when the reservation is missing or owned by another Account.
 */
abstract releaseAttachmentBlob(input: { owner: PairingAccountAuthentication reservationId: AttachmentBlobReservationId }): Promise<void>
```

Source: [`packages/platform/remote-access/src/index.ts`](../../packages/platform/remote-access/src/index.ts)

<a id="ctxremoteattachmentauthority--remoteattachmentauthority"></a>

### `ctx.remoteAttachmentAuthority` — `RemoteAttachmentAuthority`

Pairing scope seam: the Personal Pairing layer authenticates one HTTPS request to exactly one Personal Pairing. Implementations never see attachment bytes.

```ts cordis-catalog
/**
 * Authenticate one attachment request to its owning Personal Pairing.
 * @param input - complete untrusted request headers.
 * @returns pairing authority plus Account-complete blob admission.
 */
authenticate(input: { headers: IncomingHttpHeaders }): Promise<{ pairingId: PersonalPairingId admit(bytes: number): Promise<RemoteAttachmentQuotaReservation> }>
```

Source: [`packages/platform/remote-attachments/src/http.ts`](../../packages/platform/remote-attachments/src/http.ts)

<a id="ctxremoteattachments--remoteattachmentstoreservice-abstract-seam"></a>

### `ctx.remoteAttachments` — `RemoteAttachmentStoreService` (abstract seam)

Platform attachment blob store: retains ciphertext and metadata only, bounded per blob and in total, scoped to exactly one Personal Pairing, single-use, and expiring.

```ts cordis-catalog
/**
 * Retain one pairing-scoped ciphertext blob and issue its one-time capability.
 * @param input - owning Personal Pairing, endpoint-encrypted ciphertext, and current time.
 * @returns the capability grant Mobile forwards to Desktop.
 */
abstract publish(input: { pairingId: PersonalPairingId ciphertext: Uint8Array now: number quota?: RemoteAttachmentQuotaReservation }): Promise<RemoteAttachmentGrant>

/**
 * Return a copy of one retained ciphertext without consuming the capability.
 * @param input - requesting Personal Pairing, one-time capability, and current time.
 * @returns a copy of the retained ciphertext bytes.
 */
abstract inspect(input: { pairingId: PersonalPairingId; capability: AttachmentCapability; now: number }): Promise<Uint8Array>

/**
 * Exclusively claim one capability for a single HTTP response.
 * @param input - requesting Personal Pairing, one-time capability, and current time.
 * @returns claimed ciphertext plus delivery settlement operations.
 */
abstract consume(input: { pairingId: PersonalPairingId capability: AttachmentCapability now: number }): Promise<RemoteAttachmentConsumption>

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
abstract observe(): readonly RemoteAttachmentBlob[] | Promise<readonly RemoteAttachmentBlob[]>
```

Source: [`packages/platform/remote-attachments/src/index.ts`](../../packages/platform/remote-attachments/src/index.ts)

<a id="ctxremoterelay--remoterelayservice-abstract-seam"></a>

### `ctx.remoteRelay` — `RemoteRelayService` (abstract seam)

Public Remote Access Relay capability used by the WSS Consumer.

```ts cordis-catalog
/** Activate one endpoint-generated digest and replace same-endpoint authority.
 * @param routeId - route receiving endpoint-owned authority.
 * @param endpoint - endpoint kind bound to the digest.
 * @param credentialDigest - SHA-256 digest of the endpoint-owned public key.
 * @param pairingSelector - optional non-secret Personal Pairing selector.
 * @returns new route revision.
 */
abstract activateCredentialDigest( routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array, pairingSelector?: RelayPairingSelector, ): Promise<number>

/**
 * Register endpoint-generated authority without receiving its bearer credential.
 * @param routeId - active route receiving Mobile authority.
 * @param endpoint - endpoint kind bound to the digest.
 * @param credentialDigest - SHA-256 digest of the endpoint-owned credential.
 * @param pairingSelector - non-secret pairing selector retained beside the digest.
 * @returns current active route revision.
 */
abstract registerCredentialDigest( routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array, pairingSelector?: RelayPairingSelector, ): Promise<number>

/** Register one pairing's endpoint-owned Desktop and Mobile digests atomically.
 * @param routeId - route allocated to the authenticated Desktop installation.
 * @param pairingSelector - non-secret Personal Pairing selector.
 * @param desktopCredentialDigest - digest of the Desktop-owned signing credential.
 * @param mobileCredentialDigest - digest of the Mobile-owned signing credential.
 * @returns active route revision shared by both endpoint authorities.
 */
abstract registerPairingCredentialDigests( routeId: RelayRouteId, pairingSelector: RelayPairingSelector, desktopCredentialDigest: Uint8Array, mobileCredentialDigest: Uint8Array, ): Promise<number>

/** Remove endpoint-generated authority by its retained digest.
 * @param routeId - route owning the authority.
 * @param endpoint - endpoint kind bound to the digest.
 * @param credentialDigest - exact retained SHA-256 digest.
 */
abstract revokeCredentialDigest( routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array, ): Promise<void>

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
abstract attach(input: { message: RelayAttachMessage deliver: (message: RelayCiphertextMessage | RelayPeerUpdateMessage) => Promise<void> close?: () => void | Promise<void> signal?: AbortSignal announce?: (message: RelayReadyMessage) => Promise<void> }): Promise<RemoteRelayAttachment>
```

Source: [`packages/platform/remote-access/src/relay.ts`](../../packages/platform/remote-access/src/relay.ts)
<!-- END GENERATED cordis-surface -->
