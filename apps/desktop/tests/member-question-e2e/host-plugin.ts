/** DSH_HOME overlay plugin that mounts the keyless endpoint into a real Web Host. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import CompanionMemberQuestionSender, { MemberQuestionSenderError } from '@deepseek-ai/dsh-member-question-sender'
import { AskUserQuestionError } from '@deepseek-ai/dsh-tool-ask-user'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { decodeProtocolBase64Url } from '@deepseek-ai/dsh-remote-protocol'
import { KeylessMemberQuestionEndpoint } from './keyless-transport.ts'

export const name = 'member-question-keyless-host'
export const inject = ['memberQuestionReceiver', 'tools']

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
    accountId: parsePlatformAccountId(required('DSH_MEMBER_QUESTION_ACCOUNT_ID')),
    installationId: parseInstallationId(required('DSH_MEMBER_QUESTION_INSTALLATION_ID')),
    key: decodeProtocolBase64Url(
      required('DSH_MEMBER_QUESTION_KEY'),
      32,
      'keyless member-question endpoint key',
    ),
    heartbeatMs: positiveInteger('DSH_MEMBER_QUESTION_HEARTBEAT_MS', 500),
    pollMs: positiveInteger('DSH_MEMBER_QUESTION_POLL_MS', 25),
    shutdownMs: positiveInteger('DSH_MEMBER_QUESTION_SHUTDOWN_MS', 2_000),
  })
  const receiver = ctx.memberQuestionReceiver
  const sender = new CompanionMemberQuestionSender(ctx, {
    delivery: endpoint.delivery,
    presenceLookup: endpoint.presenceLookup,
    ttlMs: positiveInteger('DSH_MEMBER_QUESTION_TTL_MS', 30 * 60 * 1_000),
  })
  const asks = new Map<string, ControlAsk>()
  const controlFile = join(required('DSH_HOME'), 'member-question-e2e-control.json')
  const control = createServer((request, response) => {
    void handleControl(request, response, ctx, endpoint, asks)
  })
  ctx.effect(async () => {
    const unregisterAuthority = receiver.registerTerminalAuthority(endpoint.terminalAuthority)
    try {
      await endpoint.start({ receiver, sender })
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject)
        control.listen(0, '127.0.0.1', () => {
          control.off('error', reject)
          resolve()
        })
      })
      const address = control.address()
      if (address === null || typeof address === 'string') {
        throw new Error('member-question control exposed no TCP address')
      }
      await writeFile(controlFile, JSON.stringify({
        origin: `http://127.0.0.1:${String(address.port)}`,
      }) + '\n', { mode: 0o600 })
    } catch (error) {
      try {
        await disposeHost(control, unregisterAuthority, endpoint, controlFile)
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'member-question keyless host setup failed')
      }
      throw error
    }
    return () => disposeHost(control, unregisterAuthority, endpoint, controlFile)
  }, 'member-question-keyless-host: encrypted endpoint lifecycle')
}

async function disposeHost(
  control: ReturnType<typeof createServer>,
  unregisterAuthority: () => void,
  endpoint: KeylessMemberQuestionEndpoint,
  controlFile: string,
): Promise<void> {
  const results = await Promise.allSettled([
    closeControl(control),
    Promise.resolve().then(unregisterAuthority),
    endpoint.stop(),
    rm(controlFile, { force: true }),
  ])
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'member-question keyless host shutdown failed')
}

async function closeControl(control: ReturnType<typeof createServer>): Promise<void> {
  if (!control.listening) return
  control.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    control.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context,
  endpoint: KeylessMemberQuestionEndpoint,
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
      await endpoint.rebindAccount(parsePlatformAccountId(accountId))
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
      const input: ToolExecutionInput = {
        callId: CallId(`member-question-e2e-${token}`),
        name: 'ask_user_question',
        arguments: {
          questions: [{
            id: 'decision',
            question: requiredField(body, 'question'),
            options: [{ label: 'continue' }, { label: 'stop' }],
          }],
          to_project_member: requiredField(body, 'toAccountId'),
          background: requiredField(body, 'background'),
          references: [
            { path: 'decision.md', reason: 'Current decision' },
            { path: 'preview.html', reason: 'Restricted preview' },
            { path: 'notes.txt', reason: 'Plain notes' },
          ],
        },
        agent: routedAskAgent(requiredField(body, 'originSessionId'), required('DSH_PROJECT_MEMBERS_WORKSPACE')),
        signal: abort.signal,
      }
      void ctx.tools.execute(input).then(
        (result: ToolExecutionResult) => {
          ask.status = result.isError
            ? { state: 'failed', code: failureCode(result) }
            : { state: 'settled', outcome: 'answered' }
        },
        (error: unknown) => {
          ask.status = { state: 'failed', code: failureCode(error) }
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

function routedAskAgent(originSessionId: string, cwd: string): Agent {
  return {
    session: {
      id: originSessionId,
      header: { cwd },
    },
  } as Agent
}

function failureCode(error: unknown): string {
  if (error instanceof MemberQuestionSenderError || error instanceof AskUserQuestionError) return error.code
  if (typeof error === 'object' && error !== null && 'isError' in error) {
    const result = error as ToolExecutionResult
    const text = result.content.find(block => block.type === 'text')?.text ?? ''
    const match = text.match(/\b([A-Z][A-Z0-9_]{2,})\b/)
    if (match?.[1] !== undefined) return match[1]
  }
  return 'UNEXPECTED_FAILURE'
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
