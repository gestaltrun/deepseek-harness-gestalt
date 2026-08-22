# Platform Account

English | [中文](platform-account.zh.md)

[`@deepseek-ai/dsh-platform-account`](../../packages/platform/platform-account/README.md) defines Platform identity and the proof-of-possession Account Session bound to one Desktop or Mobile Installation. GitHub supplies only the immutable numeric subject and current public login/avatar; its OAuth token is discarded after identity validation.

## Login and session lifecycle

An Installation accepts the canonical bilingual privacy notice before it creates a five-minute `LoginAttemptView`. Mobile prepares the attempt before the authorization button can be pressed, then the button's user activation directly calls the Capacitor Browser adapter; Desktop delegates to Electron `shell.openExternal`. The system browser uses Authorization Code with S256 PKCE, random state, no OAuth scope, and one fixed HTTPS Platform callback. The application receives no callback credential or token-bearing custom URL; `LoginPollResult` completes only when a P-256 `AccountProof` redeems the single-use signed polling token.

`AccountSessionView` contains a 15-minute access token and a rotating refresh token valid for at most 30 days. A refresh is accepted only when its complete 15-minute access lifetime fits inside that absolute limit; late rejection occurs before proof consumption or token rotation. Every current-account read, refresh, and sign-out proves possession of the Installation key with a branded single-use proof JTI. The opaque `AccountSessionId` is the invalidation identity shared across Platform Instances.

## Ownership and isolation

One Installation holds one current Platform Account. Account-scoped pairing keys, caches, and operation receipts use a namespace containing the environment and Account id, so switching accounts selects separate material. A serial lifecycle owner orders restoration, refresh, login, polling, switching, and sign-out; duplicate loads cannot clear or resurrect a newer session. Desktop shutdown closes that owner, drains admitted polling, and suppresses post-dispose mutation or publication. Snapshot listeners run with independent error containment. Current-installation sign-out commits session invalidation, awaits every invalidation listener and connection closer with independent error containment, and preserves Personal Pairings.

The generic capability can validate distinct development and production identities for bounded examples and tests. Desktop and Mobile product entries accept one operated production identity before rendering or traffic: Desktop reads a release-generated public configuration from its application archive, while Mobile receives the same fields through its build configuration. The identity binds the HTTP Consumer's sole CORS origin, client transport, OAuth adapter, backend database, local store, callback, and issued account namespace; missing fields, localhost, or a mismatched Consumer origin fail before route registration. HTTP and durable records are parsed from `unknown` at their boundaries, and IndexedDB accepts only a genuine private signing P-256 `CryptoKey`. The in-memory backend and invalidation bus are fixture adapters; production persistence and distributed invalidation belong to the Platform deployment.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplatformaccount--accountservice-abstract-seam"></a>

### `ctx.platformAccount` — `AccountService` (abstract seam)

Platform Account capability. Providers own OAuth, installation-key binding, token rotation, and current-installation invalidation behind this interface.

```ts cordis-catalog
/**
 * Start one GitHub Authorization Code attempt for an installation key.
 * @param input - installation identity, kind, and public P-256 JWK.
 * @returns the system-browser URL and signed polling capability.
 * @throws AccountError `PLATFORM_CAPACITY` with `retryAfter` when the shared watermark is shedding.
 */
abstract beginLogin(input: { installationId: InstallationId installationKind: 'desktop' | 'mobile' publicKey: JsonWebKey }): Promise<LoginAttemptView>

/**
 * Settle the fixed HTTPS GitHub callback; provider credentials never leave the provider.
 * @param input - GitHub authorization code and returned random state.
 * @returns completion marker suitable for a browser confirmation page.
 */
abstract completeGitHubCallback(input: { code: string; state: string }): Promise<{ completed: true }>

/**
 * Poll one attempt using both its signed polling token and installation proof.
 * Completing a new Installation is rejected at the tenth-plus-one live Desktop or Mobile session for that Account.
 * @param input - attempt binding and one-use proof.
 * @returns pending or the newly created Account Session.
 * @throws AccountError `QUOTA` or `PLATFORM_CAPACITY` with `retryAfter` seconds.
 */
abstract pollLogin(input: { attemptId: LoginAttemptId pollingToken: string proof: AccountProof }): Promise<LoginPollResult>

/**
 * Rotate a current installation's refresh token and issue a new access token.
 * @param input - current refresh token and installation proof.
 * @returns replacement tokens retaining the original absolute refresh expiry.
 */
abstract refresh(input: { refreshToken: string; proof: AccountProof }): Promise<AccountSessionView>

/**
 * Read the current installation account.
 * @param input - access token and installation proof.
 * @returns current account projection.
 */
abstract current(input: { accessToken: string; proof: AccountProof }): Promise<PlatformAccountView>

/**
 * Authenticate the Account and Installation identity bound to one current session.
 * @param input - access token and proof from the session's Installation key.
 * @returns provider-owned Account id, Installation id, and Installation kind.
 */
abstract currentInstallation(input: { accessToken: string proof: AccountProof }): Promise<AuthenticatedInstallationView>

/**
 * Revoke only the current installation Account Session.
 * @param input - access token and installation proof.
 */
abstract signOut(input: { accessToken: string; proof: AccountProof }): Promise<void>

/**
 * Track a Platform connection so cross-instance session invalidation closes it.
 * Unbound session ids are resolved through the Account backend; missing or inactive sessions are rejected.
 * @param sessionId - Account Session owning the connection.
 * @param close - idempotent close callback.
 * @returns disposer removing the tracked connection.
 * @throws AccountError `QUOTA` with a 60-second `retryAfter` when the Account already has twenty tracked closers.
 * @throws AccountError `SESSION_REVOKED` when the session is missing or inactive.
 */
abstract trackConnection(sessionId: AccountSessionId, close: () => void | Promise<void>): Promise<() => void>
```

Source: [`packages/platform/platform-account/src/index.ts:37`](../../packages/platform/platform-account/src/index.ts)
<!-- END GENERATED cordis-surface -->
