/**
 * Dual-instance scenario over one durable document: two real Loader
 * compositions assemble the same storagePath config, each with its own
 * provider, WebServer, and process-local presence registry, over one shared
 * Account backend. Instance A commits the project and invitation rows,
 * instance B loads the authoritative document afterwards, completes the
 * acceptance, and answers the same role-gate envelopes; presence stays
 * process-local, so a heartbeat on one instance never reads online through
 * the other (Known Limitations: a shared PresenceStore is deferred).
 */

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    githubClientId: 'two-instance-development', credentialReference: 'credentials://development',
    databaseIdentity: 'two-instance-database-development', identityNamespace: 'two-instance-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'two-instance-production', credentialReference: 'credentials://production',
    databaseIdentity: 'two-instance-database-production', identityNamespace: 'two-instance-production',
  },
})

const ENVIRONMENT = selectPlatformEnvironment(ENVIRONMENT_PAIR, 'development')

/** One signed-in member's Account session: installation key, account id, bearer. */
interface Session {
  readonly key: ReturnType<typeof installationKey>
  readonly accountId: PlatformAccountId
  readonly githubLogin: string
  readonly accessToken: string
}

interface Instance {
  readonly context: Context
  readonly origin: string
  readonly service: InstanceType<typeof ProjectMembershipCore>
}

/** Account-plane state shared by both instances: one deployment, one database. */
interface Shared {
  readonly backend: MemoryAccountBackend
  readonly invalidation: MemoryAccountInvalidationBus
  readonly github: GitHubIdentityProvider
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const loaded of contexts.splice(0).reverse()) await loaded.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('two Platform instances over one membership document', () => {
  it('hands the authoritative document from instance A to instance B, which accepts and gates identically while presence stays process-local', { timeout: 60_000 }, async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-two-instance-'))
    roots.push(storagePath)
    const shared: Shared = {
      backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
      invalidation: new MemoryAccountInvalidationBus(),
      github: sequentialGithub(),
    }
    const a = await bootInstance(storagePath, shared)
    const octocat = await signIn(a.context.platformAccount, 'two-instance-octocat')
    const mona = await signIn(a.context.platformAccount, 'two-instance-mona')
    const newman = await signIn(a.context.platformAccount, 'two-instance-newman')

    const created = await post(a.origin, '/v1/projects', {
      name: 'Shared', remoteUrl: 'https://github.com/octocat/Shared.git',
    }, authHeaders(octocat))
    expect(created.status).toBe(201)
    const project = await created.json() as { id: string; boundRemoteUrl: string }
    expect(project.boundRemoteUrl).toBe('https://github.com/octocat/Shared')
    const invited = await post(a.origin, '/v1/projects/invitations', {
      projectId: project.id, githubLogin: mona.githubLogin, grantedRole: 'member',
    }, authHeaders(octocat))
    expect(invited.status).toBe(201)
    const invitation = await invited.json() as { id: string; state: string; inviteeAccountId: string; grantedRole: string }
    expect(invitation).toMatchObject({ state: 'pending', inviteeAccountId: mona.accountId, grantedRole: 'member' })

    // A's own heartbeat registers in A's process, and A's gates are the
    // envelopes instance B must reproduce.
    expect(await statusOf(heartbeat(a.origin, octocat))).toBe(204)
    expect(await rosterOf(a.origin, project.id, octocat)).toEqual({
      project: { id: project.id, name: 'Shared', boundRemoteUrl: 'https://github.com/octocat/Shared' },
      members: [{ accountId: octocat.accountId, role: 'owner', presence: 'online' }],
    })
    expect(await errorOf(fetch(`${a.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(newman) },
    }))).toEqual([403, 'NOT_A_MEMBER'])

    // Instance B boots after A's writes are durable, so its load reads the
    // same authoritative document; A's heartbeat did not cross over.
    const b = await bootInstance(storagePath, shared)
    const founder = await rosterOf(b.origin, project.id, octocat)
    expect(founder.project).toMatchObject({ id: project.id, name: 'Shared' })
    expect(founder.members).toEqual([{ accountId: octocat.accountId, role: 'owner', presence: 'offline' }])

    const accepted = await post(b.origin, `/v1/projects/invitations/${invitation.id}/decision`, {
      decision: 'accept-with-link',
      link: { workspaceName: 'mona-local', normalizedRemoteUrl: 'https://github.com/octocat/Shared' },
    }, authHeaders(mona))
    expect(accepted.status).toBe(200)
    const member = await accepted.json() as { id: string; accountId: string; role: string; link: { workspaceName: string } }
    expect(member).toMatchObject({ accountId: mona.accountId, role: 'member', link: { workspaceName: 'mona-local' } })

    // B's gates answer the same envelopes instance A produced, and B's own
    // acceptance immediately gates further invites: Mona now holds membership
    // but not admin, and re-inviting her hits the duplicate gate.
    expect(await errorOf(post(b.origin, '/v1/projects/invitations', {
      projectId: project.id, githubLogin: newman.githubLogin, grantedRole: 'member',
    }, authHeaders(mona)))).toEqual([403, 'ROLE_REQUIRED'])
    expect(await errorOf(fetch(`${b.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders(newman) },
    }))).toEqual([403, 'NOT_A_MEMBER'])
    expect(await errorOf(post(b.origin, '/v1/projects/invitations', {
      projectId: project.id, githubLogin: mona.githubLogin, grantedRole: 'member',
    }, authHeaders(octocat)))).toEqual([409, 'DUPLICATE_INVITEE'])

    const joined = await rosterOf(b.origin, project.id, octocat)
    expect(joined.members.map(({ accountId, role, presence }) => ({ accountId, role, presence }))).toEqual([
      { accountId: octocat.accountId, role: 'owner', presence: 'offline' },
      { accountId: mona.accountId, role: 'member', presence: 'offline' },
    ])

    // B's commit republished the full corpus: A's rows and B's acceptance in
    // one durable document.
    const document = JSON.parse(await readFile(b.service.storageFile, 'utf8')) as {
      projects: Array<{ id: string; boundRemoteUrl: string }>
      memberships: Array<{ accountId: string; role: string }>
      invitations: Array<{ state: string }>
    }
    expect(document.projects.map(({ id, boundRemoteUrl }) => ({ id, boundRemoteUrl }))).toEqual([{
      id: project.id, boundRemoteUrl: 'https://github.com/octocat/Shared',
    }])
    expect(document.memberships.map(row => `${row.accountId}:${row.role}`)).toEqual([
      `${octocat.accountId}:owner`, `${mona.accountId}:member`,
    ])
    expect(document.invitations.map(row => row.state)).toEqual(['accepted'])
  })
})

function installationKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: pair.publicKey.export({ format: 'jwk' }),
    proof(operation: string, binding: string): AccountProof {
      const jti = parseAccountProofJti(randomUUID())
      const issuedAt = Date.now()
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
  { providerSubject: 5558901, login: 'newman', avatarUrl: 'https://avatars.example/newman' },
]

function sequentialGithub(): GitHubIdentityProvider {
  let served = 0
  return {
    environment: ENVIRONMENT,
    authorizationUrl: () => 'https://github.com/login/oauth/authorize',
    async exchange() {
      const user = GITHUB_USERS[served]
      served += 1
      if (user === undefined) throw new Error('two-instance provider ran out of GitHub users')
      return user
    },
  }
}

/**
 * Sign in one desktop installation through the real provider on the calling
 * instance; the shared backend and signing config make the session valid on
 * both instances.
 */
async function signIn(service: AccountService, installationId: string): Promise<Session> {
  const key = installationKey()
  const attempt = await service.beginLogin({
    installationId: parseInstallationId(installationId),
    installationKind: 'desktop',
    presentation: { name: `Two-instance ${installationId}`, platform: 'linux' },
    publicKey: key.publicKey,
  })
  await service.completeGitHubCallback({ code: 'two-instance-code', state: attempt.state })
  const polled = await service.pollLogin({
    attemptId: attempt.id,
    pollingToken: attempt.pollingToken,
    proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
  })
  if (polled.status !== 'complete') throw new Error('two-instance login remained pending')
  return {
    key, accountId: polled.account.id, githubLogin: polled.account.githubLogin,
    accessToken: polled.accessToken,
  }
}

/** One fresh Account session presentation; every request needs a new proof. */
function authHeaders(session: Session): Record<string, string> {
  const proof = session.key.proof('current', hashAccountToken(session.accessToken))
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

async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin, ...headers },
    body: JSON.stringify(body),
  })
}

async function rosterOf(origin: string, projectId: string, session: Session): Promise<{
  project: { id: string; name: string; boundRemoteUrl: string }
  members: Array<{ accountId: string; role: string; presence: string }>
}> {
  const roster = await fetch(`${origin}/v1/projects/${projectId}/members`, {
    headers: { origin: ENVIRONMENT.origin, ...authHeaders(session) },
  })
  expect(roster.status).toBe(200)
  const view = await roster.json() as {
    project: { id: string; name: string; boundRemoteUrl: string }
    members: Array<{ accountId: string; role: string; presence: string }>
  }
  return {
    project: (({ id, name, boundRemoteUrl }) => ({ id, name, boundRemoteUrl }))(view.project),
    members: view.members.map(({ accountId, role, presence }) => ({ accountId, role, presence })),
  }
}

async function statusOf(response: Promise<Response> | Response): Promise<number> {
  return (await response).status
}

async function errorOf(response: Promise<Response> | Response): Promise<[number, string]> {
  const answered = await response
  const body = await answered.json() as { error: { code: string } }
  return [answered.status, body.error.code]
}

/**
 * Assemble one Platform instance over the shared storage root and shared
 * Account plane: the invariants companions, the Account provider, the
 * file-backed membership provider, and the HTTP consumer behind a real TCP
 * WebServer.
 */
async function bootInstance(storagePath: string, shared: Shared): Promise<Instance> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-two-instance-loader-'))
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
    "- name: 'two-instance-platform-account-provider'",
    "- name: '@deepseek-ai/dsh-project-membership/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-core/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-core'",
    '  config:',
    `    storagePath: '${storagePath}'`,
    "    environment: 'development'",
    "- name: '@deepseek-ai/dsh-project-membership-http/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-http'",
    '  config:',
    '    origins:',
    `      - '${ENVIRONMENT.origin}'`,
    '',
  ].join('\n'))
  const provider = {
    name: 'two-instance-platform-account-provider',
    apply(ctx: Context) {
      new PlatformAccount(ctx, {
        backend: shared.backend,
        invalidation: shared.invalidation,
        github: shared.github,
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
    ['two-instance-platform-account-provider', provider],
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
  if (typeof webServer.port !== 'number') throw new Error('two-instance composition exposed no WebServer port')
  return {
    context,
    origin: `http://127.0.0.1:${String(webServer.port)}`,
    service: context.get('projectMembership') as InstanceType<typeof ProjectMembershipCore>,
  }
}
