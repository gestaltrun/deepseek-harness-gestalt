import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  parseAccountProofJti,
  ACCOUNT_PRIVACY_NOTICE,
  parseInstallationId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountProof,
  type AccountSessionView,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'

/** Cordis name for the keyless Account acceptance composition. */
export const name = 'platform-account-keyless-scenario'

/** Run the complete Account lifecycle while the real Loader activates this plugin. */
export async function apply(ctx: Context): Promise<void> {
  const now = Date.parse('2026-08-17T10:00:00.000Z')
  const environment = selectPlatformEnvironment(validatePlatformEnvironmentPair({
    development: {
      environment: 'development',
      origin: 'https://platform.dev.example.com',
      callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
      githubClientId: 'keyless-development',
      credentialReference: 'credentials://platform-account/development/github-oauth-app',
      databaseIdentity: 'keyless-database-development',
      identityNamespace: 'keyless-development',
    },
    production: {
      environment: 'production',
      origin: 'https://platform.example.com',
      callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
      githubClientId: 'keyless-production',
      credentialReference: 'credentials://platform-account/production/github-oauth-app',
      databaseIdentity: 'keyless-database-production',
      identityNamespace: 'keyless-production',
    },
  }), 'development')
  const backend = new MemoryAccountBackend(environment.databaseIdentity)
  const invalidation = new MemoryAccountInvalidationBus()
  let callback: { code: string; state: string } | undefined
  const github: GitHubIdentityProvider = {
    environment,
    authorizationUrl(input) {
      callback = { code: 'keyless-github-code', state: input.state }
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', 'keyless-development')
      url.searchParams.set('redirect_uri', input.callbackUrl)
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },
    async exchange() {
      return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
    },
  }
  const config = {
    tokenSigningKey: Buffer.alloc(32, 1),
    pollingSigningKey: Buffer.alloc(32, 2),
  }
  const first = new PlatformAccount(ctx, {
    backend, invalidation, github, environment, config, clock: { now: () => now },
  })
  const second = new PlatformAccount(new Context(), {
    backend, invalidation, github, environment, config, clock: { now: () => now },
  })

  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  console.log('PRIVACY zh+en before authorization')
  console.log(`NOTICE zh=${ACCOUNT_PRIVACY_NOTICE.zh}`)
  console.log(`NOTICE en=${ACCOUNT_PRIVACY_NOTICE.en}`)
  const attempt = await first.beginLogin({
    installationId: parseInstallationId('desktop-keyless-1'),
    installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
    publicKey: pair.publicKey.export({ format: 'jwk' }),
  })
  const opened = attempt.authorizationUrl
  console.log(`AUTHORIZE system-browser=${new URL(opened).origin} scope=${new URL(opened).searchParams.has('scope') ? 'requested' : 'none'} pkce=${new URL(opened).searchParams.get('code_challenge_method')}`)
  if (callback === undefined) throw new Error('keyless provider did not receive an authorization URL')
  await first.completeGitHubCallback(callback)
  const polled = await second.pollLogin({
    attemptId: attempt.id,
    pollingToken: attempt.pollingToken,
    proof: proof(pair.privateKey, 'login-poll', `${attempt.id}:${hash(attempt.pollingToken)}`, now),
  })
  if (polled.status !== 'complete') throw new Error('keyless login did not complete')
  const session: AccountSessionView = polled
  console.log(`ACCOUNT githubId=${String(session.account.githubId)} login=${session.account.githubLogin}`)
  console.log(`SESSION accessMinutes=${String((session.accessExpiresAt - now) / 60_000)} refreshDays=${String((session.refreshExpiresAt - now) / 86_400_000)}`)
  let closed = false
  await second.trackConnection(session.sessionId, () => { closed = true })
  await first.signOut({
    accessToken: session.accessToken,
    proof: proof(pair.privateKey, 'sign-out', hash(session.accessToken), now),
  })
  console.log(`SIGN_OUT crossInstanceClosed=${String(closed)} local=idle`)
  await first.dispose()
  await second.dispose()
}

function proof(
  privateKey: import('node:crypto').KeyObject,
  operation: string,
  binding: string,
  issuedAt: number,
): AccountProof {
  const jti = parseAccountProofJti(randomUUID())
  return {
    jti,
    issuedAt,
    signature: sign('sha256', Buffer.from(`${operation}\n${binding}\n${issuedAt}\n${jti}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}
