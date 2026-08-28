/**
 * REAL Loader and TCP composition for the Project Membership HTTP surface:
 * keyless cordis.yml mounts the WebServer, the invariants service with every
 * invariant companion, the Account provider, both project-membership packages,
 * and this HTTP consumer; P-256 Account sessions sign in through the real
 * provider and the suite drives the full member lifecycle plus the stable
 * error envelopes through genuine TCP dispatch.
 */

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  parseAccountProofJti,
  parseInstallationId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountProof,
  type AccountService,
  type PlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  accountProofPayload,
  hashAccountToken,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ProjectMembershipCore from '@deepseek-ai/dsh-project-membership-core'
import * as PlatformAccountInvariant from '@deepseek-ai/dsh-platform-account/invariant'
import * as PlatformAccountCoreInvariant from '@deepseek-ai/dsh-platform-account-core/invariant'
import * as ProjectMembershipInvariant from '@deepseek-ai/dsh-project-membership/invariant'
import * as ProjectMembershipCoreInvariant from '@deepseek-ai/dsh-project-membership-core/invariant'
import * as ProjectMembershipHttp from '../src/index.ts'
import * as ProjectMembershipHttpInvariant from '../src/invariant.ts'

const ENVIRONMENT_PAIR = validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'assembled-development', credentialReference: 'credentials://development',
    databaseIdentity: 'assembled-database-development', identityNamespace: 'assembled-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'assembled-production', credentialReference: 'credentials://production',
    databaseIdentity: 'assembled-database-production', identityNamespace: 'assembled-production',
  },
})

const ENVIRONMENT = selectPlatformEnvironment(ENVIRONMENT_PAIR, 'development')

/** One signed-in member's Account session: installation key, account id, bearer. */
interface Session {
  readonly key: ReturnType<typeof installationKey>
  readonly accountId: PlatformAccountId
  readonly accessToken: string
}

/** HTTP consumer configuration written into cordis.yml; omitted keys stay absent. */
interface HttpConfig {
  origins?: string[]
  presenceHeartbeatIntervalMs?: number
  presenceTtlMs?: number
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const loaded of contexts.splice(0).reverse()) await loaded.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('real Project Membership HTTP composition', () => {
  it.each([
    { label: 'missing origins', config: {}, failure: 'origins' },
    {
      label: 'a mismatched origin',
      config: { origins: ['https://platform.example.com'] },
      failure: 'do not include the selected Platform environment',
    },
    {
      label: 'a presence TTL not outlasting the heartbeat interval',
      config: { origins: [ENVIRONMENT.origin], presenceHeartbeatIntervalMs: 30_000, presenceTtlMs: 30_000 },
      failure: 'must exceed the heartbeat interval',
    },
  ])('fails Loader composition for $label before traffic', async ({ config, failure }) => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-http-invalid-'))
    roots.push(storagePath)
    let compositionFailure: unknown
    try {
      await loadComposition({
        storagePath,
        backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
        invalidation: new MemoryAccountInvalidationBus(),
        github: sequentialGithub(),
        config,
      })
    } catch (error) {
      compositionFailure = error
    }
    expect(String(compositionFailure)).toContain(failure)
  })

  it('boots the registry and serves create, invite, accept, roster, role, and remove over TCP', { timeout: 60_000 }, async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-http-assembled-'))
    roots.push(storagePath)
    const loaded = await loadComposition({
      storagePath,
      backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
      invalidation: new MemoryAccountInvalidationBus(),
      github: sequentialGithub(LIFECYCLE_GITHUB_USERS),
      config: { origins: [ENVIRONMENT.origin] },
    })
    const account = loaded.context.platformAccount
    const octocat = await signIn(account, 'assembled-octocat')
    const octocatMobile = await signIn(account, 'assembled-octocat-mobile', 'mobile')
    const mona = await signIn(account, 'assembled-mona')

    // Create.
    const created = await post(loaded.origin, '/v1/projects', {
      name: 'Assembled', remoteUrl: 'https://GitHub.com/octocat/Repo.GIT',
    }, authHeaders(octocat))
    expect(created.status).toBe(201)
    const project = await created.json() as { id: string; boundRemoteUrl: string }
    expect(project.boundRemoteUrl).toBe('https://github.com/octocat/Repo')

    // The 401 envelope: a request with no Account session at all.
    expect(await errorOf(post(loaded.origin, '/v1/projects', {
      name: 'Unauthenticated', remoteUrl: 'https://github.com/octocat/repo',
    }))).toEqual([401, 'AUTH_REQUIRED'])

    // Invite and accept.
    const invited = await post(loaded.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: mona.accountId,
    }, authHeaders(octocat))
    expect(invited.status).toBe(201)
    const invitation = await invited.json() as { id: string; state: string; inviteeAccountId: string }
    expect(invitation).toMatchObject({ state: 'pending', inviteeAccountId: mona.accountId })
    const accepted = await post(loaded.origin, `/v1/projects/invitations/${invitation.id}/decision`, {
      decision: 'accept-with-link',
      link: { workspaceName: 'mona-local', normalizedRemoteUrl: 'https://github.com/octocat/Repo' },
    }, authHeaders(mona))
    expect(accepted.status).toBe(200)
    const member = await accepted.json() as { id: string; role: string }
    expect(member.role).toBe('member')

    // Roster after a desktop heartbeat: per-member presence plus the public
    // identity joined from the authoritative Account store. Presence is a
    // Desktop cadence, so the Mobile installation's beat is refused.
    expect(await errorOf(heartbeat(loaded.origin, octocatMobile))).toEqual([403, 'INSTALLATION_KIND_UNSUPPORTED'])
    expect(await statusOf(heartbeat(loaded.origin, octocat))).toBe(204)
    const roster = await fetch(`${loaded.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
    })
    expect(roster.status).toBe(200)
    const view = await roster.json() as {
      project: { id: string; name: string }
      members: Array<{ accountId: string; role: string; presence: string; displayName: string; avatarRef: string }>
    }
    expect(view.project).toMatchObject({ id: project.id, name: 'Assembled' })
    expect(view.members.map(({ accountId, role, presence, displayName, avatarRef }) => (
      { accountId, role, presence, displayName, avatarRef }
    ))).toEqual([
      {
        accountId: octocat.accountId, role: 'owner', presence: 'online',
        displayName: 'octocat', avatarRef: 'https://avatars.example/octocat',
      },
      {
        accountId: mona.accountId, role: 'member', presence: 'offline',
        displayName: 'mona', avatarRef: 'https://avatars.example/mona',
      },
    ])

    // Role change and removal; the removed member then meets the 403 envelope.
    expect(await statusOf(post(loaded.origin, `/v1/projects/memberships/${member.id}/role`, {
      role: 'admin',
    }, authHeaders(octocat)))).toBe(204)
    expect(await statusOf(fetch(`${loaded.origin}/v1/projects/memberships/${member.id}`, {
      method: 'DELETE', headers: { origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
    }))).toBe(204)
    expect(await errorOf(fetch(`${loaded.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(mona) },
    }))).toEqual([403, 'NOT_A_MEMBER'])
  })

  it('answers the roster with empty identity fields once an account record leaves the Account store', { timeout: 60_000 }, async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-http-degraded-'))
    roots.push(storagePath)
    const backend = new AccountStoreWithDeletion(ENVIRONMENT.databaseIdentity)
    const loaded = await loadComposition({
      storagePath,
      backend,
      invalidation: new MemoryAccountInvalidationBus(),
      github: sequentialGithub(),
      config: { origins: [ENVIRONMENT.origin] },
    })
    const account = loaded.context.platformAccount
    const octocat = await signIn(account, 'degraded-octocat')
    const mona = await signIn(account, 'degraded-mona')
    const project = await createProjectWithMember(loaded.origin, octocat, mona)

    // The account record leaves the authoritative store after the join; the
    // roster read must degrade to empty identity fields instead of failing.
    backend.forget(mona.accountId)
    const roster = await fetch(`${loaded.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
    })
    expect(roster.status).toBe(200)
    const view = await roster.json() as {
      members: Array<{ accountId: string; presence: string; displayName: string; avatarRef: string }>
    }
    expect(view.members.map(({ accountId, presence, displayName, avatarRef }) => (
      { accountId, presence, displayName, avatarRef }
    ))).toEqual([
      { accountId: octocat.accountId, presence: 'offline', displayName: 'octocat', avatarRef: 'https://avatars.example/octocat' },
      { accountId: mona.accountId, presence: 'offline', displayName: '', avatarRef: '' },
    ])
  })

  it('expires presence after the configured TTL', { timeout: 60_000 }, async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-http-ttl-'))
    roots.push(storagePath)
    const loaded = await loadComposition({
      storagePath,
      backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
      invalidation: new MemoryAccountInvalidationBus(),
      github: sequentialGithub(),
      config: { origins: [ENVIRONMENT.origin], presenceHeartbeatIntervalMs: 10, presenceTtlMs: 25 },
    })
    const octocat = await signIn(loaded.context.platformAccount, 'ttl-octocat')
    const created = await post(loaded.origin, '/v1/projects', {
      name: 'Ttl', remoteUrl: 'https://github.com/octocat/repo',
    }, authHeaders(octocat))
    const project = await created.json() as { id: string }
    expect(await statusOf(heartbeat(loaded.origin, octocat))).toBe(204)
    expect(await presenceOf(loaded.origin, project.id, octocat)).toBe('online')
    await new Promise((resolve) => { setTimeout(resolve, 45) })
    expect(await presenceOf(loaded.origin, project.id, octocat)).toBe('offline')
  })

  it('answers protocol and domain failures with the stable error envelopes', { timeout: 60_000 }, async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-http-envelopes-'))
    roots.push(storagePath)
    const loaded = await loadComposition({
      storagePath,
      backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
      invalidation: new MemoryAccountInvalidationBus(),
      github: sequentialGithub(),
      config: { origins: [ENVIRONMENT.origin] },
    })
    const octocat = await signIn(loaded.context.platformAccount, 'envelope-octocat')
    const created = await post(loaded.origin, '/v1/projects', {
      name: 'Envelopes', remoteUrl: 'https://github.com/octocat/repo',
    }, authHeaders(octocat))
    const project = await created.json() as { id: string }

    const revoked = await post(loaded.origin, '/v1/projects', {
      name: 'x', remoteUrl: 'https://github.com/o/r',
    }, {
      authorization: 'Bearer access-revoked',
      'x-gestalt-proof-jti': randomUUID(),
      'x-gestalt-proof-issued-at': String(Date.now()),
      'x-gestalt-proof-signature': 'signature',
    })
    expect(await errorOf(revoked)).toEqual([401, 'SESSION_REVOKED'])
    const staleProof = await post(loaded.origin, '/v1/projects', {
      name: 'x', remoteUrl: 'https://github.com/o/r',
    }, authHeaders(octocat, Date.now() - 10 * 60_000))
    expect(await errorOf(staleProof)).toEqual([401, 'PROOF_INVALID'])
    // Authentication precedes body parsing: a malformed body with no session
    // still answers the authentication envelope.
    const unauthenticatedBadBody = await fetch(`${loaded.origin}/v1/projects`, {
      method: 'POST', body: '{', headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin },
    })
    expect(await errorOf(unauthenticatedBadBody)).toEqual([401, 'AUTH_REQUIRED'])
    const malformedBody = await fetch(`${loaded.origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
      body: '{',
    })
    expect(await errorOf(malformedBody)).toEqual([400, 'INVALID_JSON'])
    const missingProof = await fetch(`${loaded.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ENVIRONMENT.origin, authorization: `Bearer ${octocat.accessToken}` },
    })
    expect(await errorOf(missingProof)).toEqual([400, 'INVALID_REQUEST'])
    const untrustedOrigin = await fetch(`${loaded.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: 'https://evil.example', ...authHeaders(octocat) },
    })
    expect(await errorOf(untrustedOrigin)).toEqual([403, 'ORIGIN_DENIED'])

    expect(await errorOf(post(loaded.origin, '/v1/projects', {
      name: 'Envelopes', remoteUrl: 'https://github.com/octocat/repo',
    }, authHeaders(octocat)))).toEqual([409, 'PROJECT_NAME_TAKEN'])
    expect(await errorOf(post(loaded.origin, '/v1/projects', {
      name: 'Other', remoteUrl: 'not-a-remote',
    }, authHeaders(octocat)))).toEqual([400, 'INVALID_REMOTE_URL'])
    expect(await errorOf(post(loaded.origin, '/v1/projects/invitations/unknown/decision', {
      decision: 'later',
    }, authHeaders(octocat)))).toEqual([400, 'INVALID_REQUEST'])
    expect(await errorOf(post(loaded.origin, '/v1/projects/invitations/unknown/decision', {
      decision: 'decline', extra: true,
    }, authHeaders(octocat)))).toEqual([400, 'INVALID_REQUEST'])
    expect(await errorOf(post(loaded.origin, '/v1/projects/memberships/unknown/role', {
      role: 'spectator',
    }, authHeaders(octocat)))).toEqual([400, 'INVALID_REQUEST'])
    expect(await errorOf(post(loaded.origin, '/v1/projects/memberships/unknown/role', {
      role: 'member',
    }, authHeaders(octocat)))).toEqual([404, 'MEMBERSHIP_NOT_FOUND'])

    expect(await errorOf(fetch(`${loaded.origin}/v1/projects/${project.id}/unknown`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
    }))).toEqual([404, 'NOT_FOUND'])
    expect(await errorOf(fetch(`${loaded.origin}/v1/projects`, {
      method: 'GET', headers: { origin: ENVIRONMENT.origin },
    }))).toEqual([405, 'METHOD_NOT_ALLOWED'])
    expect(await errorOf(post(loaded.origin, '/v1/projects', { value: 'x'.repeat(65_537) }, authHeaders(octocat))))
      .toEqual([413, 'REQUEST_TOO_LARGE'])
    expect(await errorOf(fetch(`${loaded.origin}/v1/projects/%zz/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
    }))).toEqual([400, 'INVALID_REQUEST'])
    expect(await errorOf(fetch(`${loaded.origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin, ...authHeaders(octocat) },
      body: 'null',
    }))).toEqual([400, 'INVALID_JSON'])
  })
})

/**
 * One account record leaving the authoritative store: models an account the
 * Account plane no longer knows while its membership rows persist.
 */
class AccountStoreWithDeletion extends MemoryAccountBackend {
  private hidden: PlatformAccountId | undefined

  /** Hide one account record from every subsequent authoritative read. */
  forget(accountId: PlatformAccountId): void {
    this.hidden = accountId
  }

  override async getAccount(id: PlatformAccountId) {
    return id === this.hidden ? undefined : super.getAccount(id)
  }
}

function installationKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: pair.publicKey.export({ format: 'jwk' }),
    proof(operation: string, binding: string, issuedAt = Date.now()): AccountProof {
      const jti = parseAccountProofJti(randomUUID())
      return {
        jti,
        issuedAt,
        signature: sign('sha256', accountProofPayload({ operation, binding, issuedAt, jti }), {
          key: pair.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      }
    },
  }
}

const GITHUB_USERS = [
  { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
  { providerSubject: 721119, login: 'mona', avatarUrl: 'https://avatars.example/mona' },
]

/** Lifecycle sign-ins: the second octocat exchange is the same account's second installation. */
const LIFECYCLE_GITHUB_USERS = [
  { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
  { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
  { providerSubject: 721119, login: 'mona', avatarUrl: 'https://avatars.example/mona' },
]

function sequentialGithub(
  users: Array<{ providerSubject: number; login: string; avatarUrl: string }> = GITHUB_USERS,
): GitHubIdentityProvider {
  let served = 0
  return {
    environment: ENVIRONMENT,
    authorizationUrl: () => 'https://github.com/login/oauth/authorize',
    async exchange() {
      const user = users[served]
      served += 1
      if (user === undefined) throw new Error('assembled provider ran out of GitHub users')
      return user
    },
  }
}

/**
 * Sign in one installation through the real provider: begin the PKCE attempt,
 * settle the GitHub callback, and poll with a fresh installation proof.
 */
async function signIn(
  service: AccountService,
  installationId: string,
  installationKind: 'desktop' | 'mobile' = 'desktop',
): Promise<Session> {
  const key = installationKey()
  const attempt = await service.beginLogin(installationKind === 'desktop'
    ? {
      installationId: parseInstallationId(installationId),
      installationKind,
      presentation: { name: `Assembled ${installationId}`, platform: 'linux' },
      publicKey: key.publicKey,
    }
    : {
      installationId: parseInstallationId(installationId),
      installationKind,
      presentation: { name: `Assembled ${installationId}`, platform: 'ios' },
      publicKey: key.publicKey,
    })
  await service.completeGitHubCallback({ code: 'assembled-code', state: attempt.state })
  const polled = await service.pollLogin({
    attemptId: attempt.id,
    pollingToken: attempt.pollingToken,
    proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
  })
  if (polled.status !== 'complete') throw new Error('assembled login remained pending')
  return { key, accountId: polled.account.id, accessToken: polled.accessToken }
}

/** One fresh Account session presentation; every request needs a new proof. */
function authHeaders(session: Session, issuedAt = Date.now()): Record<string, string> {
  const proof = session.key.proof('current', hashAccountToken(session.accessToken), issuedAt)
  return {
    authorization: `Bearer ${session.accessToken}`,
    'x-gestalt-proof-jti': proof.jti,
    'x-gestalt-proof-issued-at': String(proof.issuedAt),
    'x-gestalt-proof-signature': proof.signature,
  }
}

function heartbeat(origin: string, session: Session): Promise<Response> {
  return fetch(`${origin}/v1/projects/presence/heartbeat`, {
    method: 'POST', headers: { origin: ENVIRONMENT.origin, ...authHeaders(session) },
  })
}

/**
 * Create one project as the founding member and join the second member through
 * an accepted invitation, producing a two-member roster.
 */
async function createProjectWithMember(origin: string, founder: Session, joiner: Session): Promise<{ id: string }> {
  const created = await post(origin, '/v1/projects', {
    name: `Assembled-${founder.accountId}`, remoteUrl: 'https://github.com/octocat/repo',
  }, authHeaders(founder))
  expect(created.status).toBe(201)
  const project = await created.json() as { id: string }
  const invited = await post(origin, '/v1/projects/invitations', {
    projectId: project.id, inviteeAccountId: joiner.accountId,
  }, authHeaders(founder))
  expect(invited.status).toBe(201)
  const invitation = await invited.json() as { id: string }
  const accepted = await post(origin, `/v1/projects/invitations/${invitation.id}/decision`, {
    decision: 'accept-with-link', link: { workspaceName: 'joiner-local' },
  }, authHeaders(joiner))
  expect(accepted.status).toBe(200)
  return project
}

async function presenceOf(origin: string, projectId: string, session: Session): Promise<string> {
  const roster = await fetch(`${origin}/v1/projects/${projectId}/members`, {
    headers: { origin: ENVIRONMENT.origin, ...authHeaders(session) },
  })
  expect(roster.status).toBe(200)
  return (await roster.json() as { members: Array<{ presence: string }> }).members[0]?.presence ?? 'missing'
}

async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin, ...headers },
    body: JSON.stringify(body),
  })
}

async function statusOf(response: Promise<Response> | Response): Promise<number> {
  return (await response).status
}

async function errorOf(response: Promise<Response> | Response): Promise<[number, string]> {
  const answered = await response
  const body = await answered.json() as { error: { code: string } }
  return [answered.status, body.error.code]
}

async function loadComposition(options: {
  storagePath: string
  backend: MemoryAccountBackend
  invalidation: MemoryAccountInvalidationBus
  github: GitHubIdentityProvider
  config: HttpConfig
}): Promise<{ context: Context; origin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-http-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-invariants'",
    "- name: '@deepseek-ai/dsh-platform-account/invariant'",
    "- name: '@deepseek-ai/dsh-platform-account-core/invariant'",
    "- name: 'assembled-platform-account-provider'",
    "- name: '@deepseek-ai/dsh-project-membership/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-core/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-core'",
    '  config:',
    `    storagePath: '${options.storagePath}'`,
    "    environment: 'development'",
    "- name: '@deepseek-ai/dsh-project-membership-http/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-http'",
    ...httpConfigLines(options.config),
    '',
  ].join('\n'))
  const provider = {
    name: 'assembled-platform-account-provider',
    apply(ctx: Context) {
      new PlatformAccount(ctx, {
        backend: options.backend,
        invalidation: options.invalidation,
        github: options.github,
        environment: ENVIRONMENT,
        config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
      })
    },
  }
  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-invariants', InvariantRegistry],
    ['@deepseek-ai/dsh-platform-account/invariant', PlatformAccountInvariant],
    ['@deepseek-ai/dsh-platform-account-core/invariant', PlatformAccountCoreInvariant],
    ['assembled-platform-account-provider', provider],
    ['@deepseek-ai/dsh-project-membership/invariant', ProjectMembershipInvariant],
    ['@deepseek-ai/dsh-project-membership-core/invariant', ProjectMembershipCoreInvariant],
    ['@deepseek-ai/dsh-project-membership-core', ProjectMembershipCore],
    ['@deepseek-ai/dsh-project-membership-http/invariant', ProjectMembershipHttpInvariant],
    ['@deepseek-ai/dsh-project-membership-http', ProjectMembershipHttp],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const webServer = context.get('webServer') as unknown as { port: number }
  if (typeof webServer.port !== 'number') throw new Error('assembled composition exposed no WebServer port')
  return { context, origin: `http://127.0.0.1:${String(webServer.port)}` }
}

function httpConfigLines(config: HttpConfig): string[] {
  const entries = Object.entries(config).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return []
  return [
    '  config:',
    ...entries.flatMap(([key, value]) => Array.isArray(value)
      ? [`    ${key}:`, ...value.map(entry => `      - '${String(entry)}'`)]
      : [`    ${key}: ${String(value)}`]),
  ]
}
