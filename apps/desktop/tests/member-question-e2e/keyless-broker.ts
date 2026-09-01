/** Loopback-only ciphertext broker for keyless member-question acceptance. */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  parseInstallationId,
  parsePlatformAccountId,
  type InstallationId,
  type PlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
  type MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { ProjectId } from '@deepseek-ai/dsh-project-membership'

interface BrokerLease {
  readonly accountId: PlatformAccountId
  readonly installationId: InstallationId
  expiresAt: number
}

interface BrokerQuestionEvent {
  readonly seq: number
  readonly kind: 'question'
  readonly questionId: MemberQuestionId
  readonly projectId: ProjectId
  readonly fromAccountId: PlatformAccountId
  readonly toAccountId: PlatformAccountId
  readonly targets: readonly InstallationId[]
  readonly ciphertexts: readonly string[]
}

interface BrokerTerminalEvent {
  readonly seq: number
  readonly kind: 'terminal'
  readonly questionId: MemberQuestionId
  readonly targets: readonly InstallationId[]
  readonly ciphertext: string
}

type BrokerEvent = BrokerQuestionEvent | BrokerTerminalEvent

interface BrokerQuestionRoute {
  readonly fromAccountId: PlatformAccountId
  readonly toAccountId: PlatformAccountId
  readonly targetInstallations: readonly InstallationId[]
}

interface BrokerTerminal {
  readonly ciphertext: string
  readonly digest: string
}

/** Content-free broker observation retained as acceptance evidence. */
interface KeylessBrokerAuditEntry {
  readonly operation: 'presence' | 'deliver' | 'terminal'
  readonly accountIds: readonly PlatformAccountId[]
  readonly questionId?: MemberQuestionId
  readonly ciphertextBytes?: number
  readonly ciphertextDigest?: string
}

/** Running loopback broker and its content-free audit projection. */
export interface KeylessMemberQuestionBroker {
  readonly origin: string
  readonly audit: readonly KeylessBrokerAuditEntry[]
  close(): Promise<void>
}

export interface KeylessMemberQuestionBrokerOptions {
  readonly now?: () => number
  readonly presenceTtlMs?: number
}

/** Start one real TCP listener that retains routing metadata and ciphertext only. */
export async function startKeylessMemberQuestionBroker(
  options: KeylessMemberQuestionBrokerOptions = {},
): Promise<KeylessMemberQuestionBroker> {
  const now = options.now ?? Date.now
  const presenceTtlMs = options.presenceTtlMs ?? 2_000
  const leases = new Map<InstallationId, BrokerLease>()
  const events: BrokerEvent[] = []
  const routes = new Map<MemberQuestionId, BrokerQuestionRoute>()
  const terminals = new Map<MemberQuestionId, BrokerTerminal>()
  const audit: KeylessBrokerAuditEntry[] = []
  let seq = 0

  const activeInstallations = (accountId: PlatformAccountId): InstallationId[] => {
    const observedAt = now()
    for (const [installationId, lease] of leases) {
      if (lease.expiresAt <= observedAt) leases.delete(installationId)
    }
    return [...leases.values()]
      .filter(lease => lease.accountId === accountId)
      .map(lease => lease.installationId)
      .sort()
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://loopback')
    if (request.method === 'POST' && url.pathname === '/v1/member-questions/presence') {
      const body = await readJson(request)
      const accountId = parsePlatformAccountId(body.accountId)
      const installationId = parseInstallationId(body.installationId)
      leases.set(installationId, { accountId, installationId, expiresAt: now() + presenceTtlMs })
      json(response, 200, { online: true, expiresAt: now() + presenceTtlMs })
      return
    }
    if (request.method === 'DELETE' && url.pathname === '/v1/member-questions/presence') {
      const body = await readJson(request)
      const installationId = parseInstallationId(body.installationId)
      leases.delete(installationId)
      json(response, 200, { online: false })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/member-questions/presence') {
      const accountId = parsePlatformAccountId(url.searchParams.get('accountId'))
      json(response, 200, { online: activeInstallations(accountId).length > 0 })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/member-questions/deliver') {
      const body = await readJson(request)
      const questionId = parseMemberQuestionId(body.questionId)
      const projectId = parseMemberQuestionProjectId(body.projectId)
      const fromAccountId = parsePlatformAccountId(body.fromAccountId)
      const toAccountId = parsePlatformAccountId(body.toAccountId)
      const ciphertexts = stringArray(body.ciphertexts, 'ciphertexts')
      const targets = activeInstallations(toAccountId)
      if (targets.length === 0) {
        json(response, 409, { error: 'MEMBER_OFFLINE' })
        return
      }
      if (routes.has(questionId)) throw new Error(`question ${questionId} was already delivered`)
      routes.set(questionId, { fromAccountId, toAccountId, targetInstallations: targets })
      events.push({
        seq: ++seq,
        kind: 'question',
        questionId,
        projectId,
        fromAccountId,
        toAccountId,
        targets,
        ciphertexts,
      })
      const bytes = ciphertexts.reduce((sum, value) => sum + Buffer.byteLength(value), 0)
      audit.push({
        operation: 'deliver', accountIds: [fromAccountId, toAccountId], questionId,
        ciphertextBytes: bytes, ciphertextDigest: digest(ciphertexts.join('.')),
      })
      json(response, 202, { accepted: true, installations: targets.length })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/member-questions/terminal') {
      const body = await readJson(request)
      const questionId = parseMemberQuestionId(body.questionId)
      const ciphertext = nonEmpty(body.ciphertext, 'ciphertext')
      const route = routes.get(questionId)
      if (route === undefined) throw new Error(`question ${questionId} has no delivery route`)
      let retained = terminals.get(questionId)
      const claimed = retained === undefined
      if (retained === undefined) {
        retained = { ciphertext, digest: digest(ciphertext) }
        terminals.set(questionId, retained)
        const sourceTargets = activeInstallations(route.fromAccountId)
        const targets = [...new Set([...route.targetInstallations, ...sourceTargets])].sort()
        events.push({ seq: ++seq, kind: 'terminal', questionId, targets, ciphertext })
        audit.push({
          operation: 'terminal', accountIds: [route.fromAccountId, route.toAccountId], questionId,
          ciphertextBytes: Buffer.byteLength(ciphertext), ciphertextDigest: retained.digest,
        })
      }
      json(response, 200, { claimed, ciphertext: retained.ciphertext })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/member-questions/terminal') {
      const questionId = parseMemberQuestionId(url.searchParams.get('questionId'))
      const retained = terminals.get(questionId)
      json(response, 200, retained === undefined ? { state: 'pending' } : {
        state: 'terminal', ciphertext: retained.ciphertext,
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/member-questions/events') {
      const accountId = parsePlatformAccountId(url.searchParams.get('accountId'))
      const installationId = parseInstallationId(url.searchParams.get('installationId'))
      const after = Number(url.searchParams.get('after') ?? '0')
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a safe integer >= 0')
      const live = activeInstallations(accountId)
      const lease = leases.get(installationId)
      if (lease?.accountId !== accountId || !live.includes(installationId)) {
        json(response, 401, { error: 'INSTALLATION_OFFLINE' })
        return
      }
      const selected = events.filter(event => event.seq > after && event.targets.includes(installationId))
      json(response, 200, { events: selected.map(publicEvent), cursor: selected.at(-1)?.seq ?? after })
      return
    }
    if (request.method === 'GET' && url.pathname === '/__audit') {
      json(response, 200, { entries: audit })
      return
    }
    json(response, 404, { error: 'NOT_FOUND' })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('keyless broker exposed no TCP address')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    audit,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

function publicEvent(event: BrokerEvent): Omit<BrokerEvent, 'targets'> {
  const { targets: _targets, ...projected } = event
  return projected
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 32 * 1_024 * 1_024) throw new Error('request exceeds 32 MiB')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('body must be an object')
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`)
  return value.map((entry, index) => nonEmpty(entry, `${name}[${String(index)}]`))
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}
