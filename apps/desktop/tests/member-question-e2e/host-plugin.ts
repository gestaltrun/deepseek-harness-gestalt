/** DSH_HOME overlay plugin that mounts the keyless endpoint into a real Web Host. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import CompanionMemberQuestionSender, { MemberQuestionSenderError } from '@deepseek-ai/dsh-member-question-sender'
import {
  decodeProtocolBase64Url,
  parseCompanionSessionId,
  parseMemberQuestionProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import { KeylessMemberQuestionEndpoint } from './keyless-transport.ts'

export const name = 'member-question-keyless-host'
export const inject = ['memberQuestionReceiver']

type ControlAskStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'settled'; readonly outcome: 'answered' | 'declined' }
  | { readonly state: 'failed'; readonly code: string }

interface ControlAsk {
  readonly abort: AbortController
  status: ControlAskStatus
}

/** Mount one endpoint and bind both sender and receiver transport faces. */
export function apply(ctx: Context): void {
  const endpoint = new KeylessMemberQuestionEndpoint({
    origin: required('DSH_MEMBER_QUESTION_KEYLESS_ORIGIN'),
    accountId: required('DSH_MEMBER_QUESTION_ACCOUNT_ID'),
    installationId: required('DSH_MEMBER_QUESTION_INSTALLATION_ID'),
    key: decodeProtocolBase64Url(
      required('DSH_MEMBER_QUESTION_KEY'),
      32,
      'keyless member-question endpoint key',
    ),
    heartbeatMs: positiveInteger('DSH_MEMBER_QUESTION_HEARTBEAT_MS', 500),
    pollMs: positiveInteger('DSH_MEMBER_QUESTION_POLL_MS', 25),
  })
  const receiver = ctx.memberQuestionReceiver
  const unregisterAuthority = receiver.registerTerminalAuthority(endpoint.terminalAuthority)
  const sender = new CompanionMemberQuestionSender(ctx, {
    delivery: endpoint.delivery,
    presenceLookup: endpoint.presenceLookup,
    ttlMs: positiveInteger('DSH_MEMBER_QUESTION_TTL_MS', 30 * 60 * 1_000),
  })
  const asks = new Map<string, ControlAsk>()
  const controlFile = join(required('DSH_HOME'), 'member-question-e2e-control.json')
  const control = createServer((request, response) => {
    void handleControl(request, response, endpoint, sender, asks)
  })
  ctx.effect(async () => {
    await endpoint.start({ receiver, sender })
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject)
      control.listen(0, '127.0.0.1', () => {
        control.off('error', reject)
        resolve()
      })
    })
    const address = control.address()
    if (address === null || typeof address === 'string') throw new Error('member-question control exposed no TCP address')
    await writeFile(controlFile, JSON.stringify({
      origin: `http://127.0.0.1:${String(address.port)}`,
    }) + '\n', { mode: 0o600 })
    return async () => {
      control.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        control.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      unregisterAuthority()
      await endpoint.stop()
      await rm(controlFile, { force: true })
    }
  }, 'member-question-keyless-host: encrypted endpoint lifecycle')
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: KeylessMemberQuestionEndpoint,
  sender: CompanionMemberQuestionSender,
  asks: Map<string, ControlAsk>,
): Promise<void> {
  try {
    if (request.method !== 'POST') {
      respond(response, 405, { error: 'method-not-allowed' })
      return
    }
    const body = await readBody(request)
    if (request.url === '/identity') {
      const accountId = requiredField(body, 'accountId')
      await endpoint.rebindAccount(accountId)
      respond(response, 200, { accountId })
      return
    }
    if (request.url === '/project') {
      const projectId = requiredField(body, 'projectId')
      process.env.DSH_PROJECT_MEMBERS_PROJECT_ID = projectId
      respond(response, 200, { projectId })
      return
    }
    if (request.url === '/online') {
      const online = requiredBoolean(body, 'online')
      await endpoint.setOnline(online)
      respond(response, 200, { online })
      return
    }
    if (request.url === '/ask') {
      const token = requiredField(body, 'token')
      if (asks.has(token)) throw new Error(`ask token ${token} already exists`)
      const abort = new AbortController()
      const ask: ControlAsk = { abort, status: { state: 'pending' } }
      asks.set(token, ask)
      void sender.send({
        toProjectMember: requiredField(body, 'toAccountId'),
        projectId: parseMemberQuestionProjectId(requiredField(body, 'projectId')),
        background: requiredField(body, 'background'),
        questions: [{
          id: 'decision',
          question: requiredField(body, 'question'),
          options: [{ label: 'continue' }, { label: 'stop' }],
        }],
        references: [],
        documents: [],
        origin: {
          projectName: requiredField(body, 'projectName'),
          originSessionTitle: requiredField(body, 'title'),
          askerAccountId: requiredField(body, 'askerAccountId'),
          askerRole: 'owner',
          askerDisplayName: 'Ada',
          askerAvatarUrl: 'https://avatars.example/ada.png',
        },
        originSessionId: parseCompanionSessionId(requiredField(body, 'originSessionId')),
      }, { signal: abort.signal }).then(
        (result) => { ask.status = { state: 'settled', outcome: result.outcome } },
        (error: unknown) => {
          ask.status = {
            state: 'failed',
            code: error instanceof MemberQuestionSenderError ? error.code : 'UNEXPECTED_FAILURE',
          }
        },
      )
      respond(response, 202, { token })
      return
    }
    if (request.url === '/withdraw') {
      const token = requiredField(body, 'token')
      const ask = asks.get(token)
      if (ask === undefined) throw new Error(`ask token ${token} does not exist`)
      ask.abort.abort()
      respond(response, 202, { token })
      return
    }
    if (request.url === '/status') {
      const token = requiredField(body, 'token')
      const ask = asks.get(token)
      if (ask === undefined) throw new Error(`ask token ${token} does not exist`)
      respond(response, 200, ask.status)
      return
    }
    respond(response, 404, { error: 'not-found' })
  } catch (error) {
    respond(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 4_096) throw new Error('member-question control body exceeded 4096 bytes')
    chunks.push(buffer)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('member-question control body must be an object')
  }
  return value as Record<string, unknown>
}

function requiredField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function requiredBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field]
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}

function positiveInteger(name: string, fallback: number): number {
  const source = process.env[name]
  if (source === undefined) return fallback
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}
