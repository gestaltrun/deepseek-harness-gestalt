import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  parseAccountProofJti,
  parseInstallationId,
  type AccountProof,
  type AccountService,
  type PlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  accountProofPayload,
  hashAccountToken,
} from '@deepseek-ai/dsh-platform-account-core'
import CompanionMemberQuestionSender, {
  MemberQuestionSenderError,
  MemoryMemberQuestionDelivery,
} from '@deepseek-ai/dsh-member-question-sender'
import { parseCompanionSessionId, parseMemberQuestionProjectId } from '@deepseek-ai/dsh-remote-protocol'
import { ProjectMembershipHttpTransport } from '@deepseek-ai/dsh-project-membership-client'
import { ENVIRONMENT } from './src/provider.ts'

/** Cordis name for the keyless last-window Offline assembled scenario. */
export const name = 'member-presence-close-keyless-scenario'
/** Scenario dependencies assembled before the runner executes. */
export const inject = ['platformAccount', 'projectMembership', 'webServer']

interface Session {
  readonly key: ReturnType<typeof installationKey>
  readonly accountId: PlatformAccountId
  readonly githubLogin: string
  readonly accessToken: string
}

/** Drive last-window Offline through real TCP, then fail a routed ask with no queue. */
export async function apply(ctx: Context): Promise<void> {
  const origin = `http://${ctx.webServer.host}:${String(ctx.webServer.port)}`
  const octocat = await signIn(ctx.platformAccount, 'presence-close-octocat')
  const mona = await signIn(ctx.platformAccount, 'presence-close-mona')
  const created = await post(origin, '/v1/projects', {
    name: 'PresenceClose', remoteUrl: 'https://github.com/octocat/repo',
  }, authHeaders(octocat))
  if (created.status !== 201) throw new Error(`create project failed: ${String(created.status)}`)
  const project = await created.json() as { id: string }
  const invited = await post(origin, '/v1/projects/invitations', {
    projectId: project.id, githubLogin: mona.githubLogin, grantedRole: 'member',
  }, authHeaders(octocat))
  if (invited.status !== 201) throw new Error(`invite failed: ${String(invited.status)}`)
  const invitation = await invited.json() as { id: string }
  const accepted = await post(origin, `/v1/projects/invitations/${invitation.id}/decision`, {
    decision: 'accept-with-link', link: { workspaceName: 'mona-local' },
  }, authHeaders(mona))
  if (accepted.status !== 200) throw new Error(`accept failed: ${String(accepted.status)}`)
  const transport = new ProjectMembershipHttpTransport({ origin })
  await transport.heartbeat(authHeaders(mona))
  console.log(`ROSTER afterHeartbeat=${await presenceOf(origin, project.id, octocat, mona.accountId)}`)
  await transport.closePresence(authHeaders(mona))
  console.log(`ROSTER afterWindowClose=${await presenceOf(origin, project.id, octocat, mona.accountId)}`)
  const delivery = new MemoryMemberQuestionDelivery()
  const sender = new CompanionMemberQuestionSender(new Context(), {
    delivery,
    presenceLookup: async () => presenceOf(origin, project.id, octocat, mona.accountId),
  })
  let code = 'delivered'
  try {
    await sender.send({
      toProjectMember: String(mona.accountId),
      projectId: parseMemberQuestionProjectId(project.id),
      background: 'This offline ask must not queue.',
      questions: [{ id: 'offline', question: 'Queued?' }],
      references: [],
      origin: {
        projectName: 'PresenceClose', originSessionTitle: 'Offline', askerAccountId: String(octocat.accountId),
        askerRole: 'owner', askerDisplayName: 'octocat', askerAvatarUrl: 'https://avatars.example/octocat',
      },
      originSessionId: parseCompanionSessionId('session-presence-close'),
    })
  } catch (error) {
    if (!(error instanceof MemberQuestionSenderError)) throw error
    code = error.code
  }
  console.log(`ASK code=${code} queued=${String(delivery.delivered.length)}`)
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

async function signIn(service: AccountService, installationId: string): Promise<Session> {
  const key = installationKey()
  const attempt = await service.beginLogin({
    installationId: parseInstallationId(installationId),
    installationKind: 'desktop',
    presentation: { name: `Presence ${installationId}`, platform: 'linux' },
    publicKey: key.publicKey,
  })
  await service.completeGitHubCallback({ code: 'presence-close-code', state: attempt.state })
  const polled = await service.pollLogin({
    attemptId: attempt.id,
    pollingToken: attempt.pollingToken,
    proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
  })
  if (polled.status !== 'complete') throw new Error('presence-close login remained pending')
  return {
    key, accountId: polled.account.id, githubLogin: polled.account.githubLogin,
    accessToken: polled.accessToken,
  }
}

function authHeaders(session: Session): Record<string, string> {
  const proof = session.key.proof('current', hashAccountToken(session.accessToken))
  return {
    authorization: `Bearer ${session.accessToken}`,
    'x-gestalt-proof-jti': proof.jti,
    'x-gestalt-proof-issued-at': String(proof.issuedAt),
    'x-gestalt-proof-signature': proof.signature,
  }
}

async function presenceOf(
  origin: string,
  projectId: string,
  reader: Session,
  accountId: PlatformAccountId,
): Promise<'online' | 'offline'> {
  const roster = await fetch(`${origin}/v1/projects/${projectId}/members`, {
    headers: { origin: ENVIRONMENT.origin, ...authHeaders(reader) },
  })
  if (roster.status !== 200) throw new Error(`roster failed: ${String(roster.status)}`)
  const view = await roster.json() as { members: Array<{ accountId: string; presence: 'online' | 'offline' }> }
  const member = view.members.find(row => row.accountId === accountId)
  if (member === undefined) throw new Error('addressed member missing from roster')
  return member.presence
}

function post(origin: string, path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin, ...headers },
    body: JSON.stringify(body),
  })
}
