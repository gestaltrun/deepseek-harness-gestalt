# Personal Pairing

English | [中文](personal-pairing.zh.md)

[`@deepseek-ai/dsh-remote-access`](../../packages/platform/remote-access/README.md) owns Mobile Access enablement, Pairing Challenge consumption, pending handshake confirmation, Personal Pairing identity, and Companion-only Device Principal authority. It calls `ctx.platformAccount.currentInstallation()` to authenticate each Account Session's installation id and kind, then compares opaque Platform Account ids; it never reads Account storage or GitHub fields and never trusts a caller-supplied installation identity.

## Challenge and confirmation lifecycle

Mobile Access is false for each Desktop Installation until the Desktop Settings owner enables it. An enabled Desktop creates one challenge containing a 32-byte invitation capability, Desktop fingerprint, rendezvous id, two-minute expiry, and protocol major. QR and full-link presentation encode the same HTTPS value. There is no short-code parser or fallback.

The Mobile completion consumes the invitation only after its complete link matches the retained capability. A cross-account attempt destroys that invitation before the crypto adapter runs. A valid same-account handshake produces a pending key and handshake hash; the six derived authentication words appear on both installations, but active pairing lists remain empty until Desktop confirmation. Confirmation activates one unique provider-owned key reference and grants a branded Device Principal whose authority is exactly `companion-surface`.

Mutations are serialized. Expiry, cancellation, rejection, disablement, and one successful completion commit terminal state before another mutation can observe the capability. When a push store is composed, `registerPushToken` accepts a `PushTokenRegistration`, `publishPushHint` returns a `CompanionPushReport`, individual revocation deletes that Mobile Installation's tokens on the Desktop route, and disablement deletes every token of the revoked routes. Crypto-resource destruction is independently retryable: a failed cleanup never repeats handshake completion or pairing activation, and provider disposal attempts every challenge, pending key, active key, and cleanup record. Challenge expiry is scheduled at creation rather than waiting for another completion request. Opaque generated ids and activated key references are checked before insertion, so a collision cannot replace an existing record or abandon a newly allocated key.

## Cryptographic adapter

`PairingHandshakeProvider` prepares, completes, activates, and destroys provider-private handshake state. Remote Access never implements Noise transitions or cryptographic primitives. `remote-access-http` consumes `ctx.remoteAccess`, while `remote-access-client` validates the wire values used by the real Desktop Settings and Mobile controllers. The assembled Loader scenario runs the provider, HTTP Consumer, and shared transport through a real loopback server with `DevelopmentKeylessPairingHandshakeProvider`. [`examples/local-companion-platform`](../../examples/local-companion-platform/README.md) keeps that same adapter on a long-running two-instance TLS origin for local Desktop and Mobile clients. Desktop and Mobile development entrypoints select their real controllers only through explicit flags. Production composition stays unavailable until the independent Noise review admits a reviewed provider; the development proof is never selected by the production path.

## Multi-instance Relay

`ctx.remoteRelay` authenticates an attachment with the opaque route id and a separate rotatable 32-byte credential, persists only its digest and revision through `RelayRouteStore`, and registers the live attachment in an expiring shared directory. `remote-access-redis` carries directory metadata, content-free invalidation, and bounded ciphertext Pub/Sub only; it creates no offline queue. A target on another Platform Instance receives the same opaque Relay frame, while a missing target returns `REMOTE_OFFLINE` immediately.

Mobile and Desktop connect outward through one non-sticky TLS endpoint. Instance loss starts a fresh connection; Desktop sends an authoritative encrypted projection after attachment, and no live socket is migrated. Closing the Desktop window quits the process, while sleep, quit, sign-out, or disabling Mobile Access stops the Relay. Production stays fail-closed until reviewed product cryptography is assembled. The keyless two-instance Loader scenario proves the transport composition without weakening that gate.

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
