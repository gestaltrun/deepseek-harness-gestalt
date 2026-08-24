/**
 * Service Definition for Platform Account identity and current-installation sessions.
 * @module @deepseek-ai/dsh-platform-account
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SelectedPlatformEnvironment } from './environment.ts'
import type {
  AccountProof,
  AuthenticatedInstallationView,
  AccountSessionView,
  AccountSessionId,
  InstallationLoginIdentity,
  LoginAttemptId,
  LoginAttemptView,
  LoginPollResult,
  PlatformAccountView,
} from './types.ts'

export * from './environment.ts'
export * from './errors.ts'
export * from './parsers.ts'
export * from './privacy.ts'
export * from './quotas.ts'
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    platformAccount: AccountService
  }
}

/**
 * Platform Account capability. Providers own OAuth, installation-key binding,
 * token rotation, and current-installation invalidation behind this interface.
 */
export abstract class AccountService extends Service {
  /** @param ctx - Platform composition context receiving this service. */
  constructor(ctx: Context) {
    super(ctx, 'platformAccount')
  }

  /** Validated deployment identity selected by this Account provider. */
  abstract readonly environment: SelectedPlatformEnvironment

  /**
   * Start one GitHub Authorization Code attempt for an installation key.
   * @param input - installation identity, Mobile presentation when applicable, and public P-256 JWK.
   * @returns the system-browser URL and signed polling capability.
   * @throws AccountError `PLATFORM_CAPACITY` with `retryAfter` when the shared watermark is shedding.
   */
  abstract beginLogin(input: InstallationLoginIdentity & { publicKey: JsonWebKey }): Promise<LoginAttemptView>

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
  abstract pollLogin(input: {
    attemptId: LoginAttemptId
    pollingToken: string
    proof: AccountProof
  }): Promise<LoginPollResult>

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
   * @returns provider-owned Account and Installation identity, including authenticated Mobile presentation.
   */
  abstract currentInstallation(input: {
    accessToken: string
    proof: AccountProof
  }): Promise<AuthenticatedInstallationView>

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
}

export default AccountService
