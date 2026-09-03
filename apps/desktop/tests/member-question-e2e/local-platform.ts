/** Real Account and Project Membership composition for keyless acceptance. */

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  parseAccountProofJti,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountProof,
  type AccountService,
  type InstallationId,
  type PlatformAccountId,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import {
  accountProofPayload,
  hashAccountToken,
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import * as PlatformAccountHttp from '@deepseek-ai/dsh-platform-account-http'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ProjectMembershipCore from '@deepseek-ai/dsh-project-membership-core'
import * as ProjectMembershipHttp from '@deepseek-ai/dsh-project-membership-http'

const KEYLESS_PLATFORM_ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://project-members.keyless.example',
    callbackUrl: 'https://project-members.keyless.example/v1/account/oauth/github/callback',
    githubClientId: 'project-members-keyless-development', credentialReference: 'credentials://keyless-development',
    databaseIdentity: 'project-members-keyless-development', identityNamespace: 'project-members-keyless-development',
  },
  production: {
    environment: 'production', origin: 'https://project-members.example',
    callbackUrl: 'https://project-members.example/v1/account/oauth/github/callback',
    githubClientId: 'project-members-production', credentialReference: 'credentials://production',
    databaseIdentity: 'project-members-production', identityNamespace: 'project-members-production',
  },
}), 'development')

export interface KeylessPlatformUser {
  readonly providerSubject: number
  readonly login: string
  readonly avatarUrl: string
}

export interface KeylessPlatformSession {
  readonly accountId: PlatformAccountId
  readonly githubLogin: string
  readonly installationId: InstallationId
  readonly accessToken: string
  readonly proof: (issuedAt?: number) => AccountProof
}

export interface LocalKeylessPlatform {
  readonly origin: string
  readonly environment: SelectedPlatformEnvironment
  signIn(installationId: InstallationId): Promise<KeylessPlatformSession>
  post(path: string, body: unknown, session: KeylessPlatformSession): Promise<Response>
  get(path: string, session: KeylessPlatformSession): Promise<Response>
  heartbeat(session: KeylessPlatformSession): Promise<Response>
  closePresence(session: KeylessPlatformSession): Promise<Response>
  retainedState(): Promise<string>
  close(): Promise<void>
}

/** Start one TCP Platform with real Account and Membership providers. */
export async function startLocalKeylessPlatform(
  users: readonly KeylessPlatformUser[],
  presence: { readonly heartbeatMs?: number; readonly ttlMs?: number } = {},
  options: { readonly publicOrigin?: string; readonly automaticAuthorization?: boolean } = {},
): Promise<LocalKeylessPlatform> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-members-keyless-platform-'))
  const context = new Context()
  const environment = options.publicOrigin === undefined
    ? KEYLESS_PLATFORM_ENVIRONMENT
    : selectPlatformEnvironment(validatePlatformEnvironmentPair({
      development: {
        environment: 'development', origin: options.publicOrigin,
        callbackUrl: `${options.publicOrigin}/v1/account/oauth/github/callback`,
        githubClientId: 'project-members-electron-development',
        credentialReference: 'credentials://electron-development',
        databaseIdentity: 'project-members-electron-development',
        identityNamespace: 'project-members-electron-development',
      },
      production: {
        environment: 'production', origin: 'https://project-members-electron.example',
        callbackUrl: 'https://project-members-electron.example/v1/account/oauth/github/callback',
        githubClientId: 'project-members-electron-production', credentialReference: 'credentials://electron-production',
        databaseIdentity: 'project-members-electron-production', identityNamespace: 'project-members-electron-production',
      },
    }), 'development')
  let served = 0
  const github: GitHubIdentityProvider = {
    environment,
    authorizationUrl: input => options.automaticAuthorization === true
      ? `${environment.callbackUrl}?code=keyless-code&state=${encodeURIComponent(input.state)}`
      : 'https://github.com/login/oauth/authorize',
    async exchange() {
      const user = users[served++]
      if (user === undefined) throw new Error('keyless Platform ran out of GitHub identities')
      return user
    },
  }
  try {
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin({
      name: 'keyless-platform-account-provider',
      apply(ctx: Context) {
        new PlatformAccount(ctx, {
          backend: new MemoryAccountBackend(environment.databaseIdentity),
          invalidation: new MemoryAccountInvalidationBus(),
          github,
          environment,
          config: { tokenSigningKey: Buffer.alloc(32, 17), pollingSigningKey: Buffer.alloc(32, 23) },
        })
      },
    })
    await context.plugin(ProjectMembershipCore, { storagePath: root, environment: 'development' })
    await context.plugin(PlatformAccountHttp, { origins: [environment.origin] })
    await context.plugin(ProjectMembershipHttp, {
      origins: [environment.origin],
      presenceHeartbeatIntervalMs: presence.heartbeatMs ?? 25,
      presenceTtlMs: presence.ttlMs ?? 100,
    })
    const webServer = context.webServer
    const origin = `http://127.0.0.1:${String(webServer.port)}`
    return {
      origin,
      environment,
      signIn: installationId => signIn(context.platformAccount, installationId),
      post: (path, body, session) => fetch(`${origin}${path}`, {
        method: 'POST',
        headers: requestHeaders(session, true, environment),
        body: JSON.stringify(body),
      }),
      get: (path, session) => fetch(`${origin}${path}`, { headers: requestHeaders(session, false, environment) }),
      heartbeat: session => fetch(`${origin}/v1/projects/presence/heartbeat`, {
        method: 'POST', headers: requestHeaders(session, false, environment),
      }),
      closePresence: session => fetch(`${origin}/v1/projects/presence/close`, {
        method: 'POST', headers: requestHeaders(session, false, environment),
      }),
      retainedState: async () => await readFile(
        join(root, 'development', 'project-membership.json'),
        'utf8',
      ).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      }),
      close: async () => {
        await context.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function signIn(service: AccountService, installationId: InstallationId): Promise<KeylessPlatformSession> {
  const key = installationKey()
  const attempt = await service.beginLogin({
    installationId,
    installationKind: 'desktop',
    presentation: { name: `Keyless ${installationId}`, platform: 'linux' },
    publicKey: key.publicKey,
  })
  await service.completeGitHubCallback({ code: 'keyless-code', state: attempt.state })
  const polled = await service.pollLogin({
    attemptId: attempt.id,
    pollingToken: attempt.pollingToken,
    proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
  })
  if (polled.status !== 'complete') throw new Error('keyless Account login remained pending')
  return {
    accountId: polled.account.id,
    githubLogin: polled.account.githubLogin,
    installationId,
    accessToken: polled.accessToken,
    proof: (issuedAt = Date.now()) => key.proof('current', hashAccountToken(polled.accessToken), issuedAt),
  }
}

function requestHeaders(
  session: KeylessPlatformSession,
  json: boolean,
  environment: SelectedPlatformEnvironment,
): Record<string, string> {
  const proof = session.proof()
  return {
    origin: environment.origin,
    authorization: `Bearer ${session.accessToken}`,
    'x-gestalt-proof-jti': proof.jti,
    'x-gestalt-proof-issued-at': String(proof.issuedAt),
    'x-gestalt-proof-signature': proof.signature,
    ...(json ? { 'content-type': 'application/json' } : {}),
  }
}

function installationKey(): {
  readonly publicKey: JsonWebKey
  proof(
    operation: Parameters<typeof accountProofPayload>[0]['operation'],
    bodyHash: string,
    issuedAt?: number,
  ): AccountProof
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = publicKey.export({ format: 'jwk' })
  return {
    publicKey: exported,
    proof(operation, bodyHash, issuedAt = Date.now()) {
      const proof = {
        jti: parseAccountProofJti(randomUUID()),
        issuedAt,
        operation,
        binding: bodyHash,
      }
      return {
        jti: proof.jti,
        issuedAt: proof.issuedAt,
        signature: sign('sha256', accountProofPayload(proof), {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      }
    },
  }
}
