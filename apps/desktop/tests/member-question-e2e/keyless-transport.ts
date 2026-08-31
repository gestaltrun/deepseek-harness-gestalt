/** Endpoint-owned encrypted client for the keyless member-question broker. */

import { createCipheriv, createDecipheriv } from 'node:crypto'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  decodeProtocolBase64Url,
  encodeCompanionMessage,
  encodeProtocolBase64Url,
  negotiateCompanionProtocol,
  type CompanionMemberQuestionSettledResult,
  type MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  MemberQuestionDocumentAssembler,
  type MemberQuestionReceiverService,
  type MemberQuestionTerminalAuthority,
  type MemberQuestionTerminalClaim as ReceiverTerminalClaim,
} from '@deepseek-ai/dsh-member-question-receiver'
import type {
  EncodedMemberQuestion,
  EncodedMemberQuestionDocument,
  MemberPresenceLookup,
  MemberQuestionDeliveryPort,
  MemberQuestionSenderService,
  MemberQuestionTerminalClaim,
} from '@deepseek-ai/dsh-member-question-sender'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { ProjectId } from '@deepseek-ai/dsh-project-membership'

const PROTOCOL = negotiateCompanionProtocol(
  createCompanionNegotiationChannel(),
  createCompanionVersionOffer('mobile'),
  createCompanionVersionOffer('desktop'),
)

export interface KeylessMemberQuestionEndpointOptions {
  readonly origin: string
  readonly accountId: string
  readonly installationId: string
  readonly key: Uint8Array
  readonly heartbeatMs?: number
  readonly pollMs?: number
}

interface BrokerQuestionEvent {
  readonly seq: number
  readonly kind: 'question'
  readonly questionId: string
  readonly projectId: string
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly ciphertexts: readonly string[]
}

interface BrokerTerminalEvent {
  readonly seq: number
  readonly kind: 'terminal'
  readonly questionId: string
  readonly ciphertext: string
}

type BrokerEvent = BrokerQuestionEvent | BrokerTerminalEvent

/** One Installation endpoint exposing sender and receiver transport faces. */
export class KeylessMemberQuestionEndpoint {
  readonly delivery: MemberQuestionDeliveryPort
  readonly terminalAuthority: MemberQuestionTerminalAuthority
  readonly presenceLookup: MemberPresenceLookup
  private readonly key: Uint8Array
  private accountId: string
  private readonly abort = new AbortController()
  private cursor = 0
  private loop: Promise<void> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private heartbeatTask: Promise<void> = Promise.resolve()
  private online = false
  private receiver: MemberQuestionReceiverService | undefined
  private sender: MemberQuestionSenderService | undefined

  constructor(private readonly options: KeylessMemberQuestionEndpointOptions) {
    if (options.key.byteLength !== 32) throw new TypeError('keyless member-question key must contain 32 bytes')
    this.key = options.key.slice()
    this.accountId = options.accountId
    this.delivery = {
      deliver: encoded => this.deliver(encoded),
      publishTerminal: terminal => this.claimTerminal(terminal),
      queryTerminal: questionId => this.queryTerminal(questionId),
    }
    this.terminalAuthority = {
      claim: terminal => this.claimTerminal(terminal),
    }
    this.presenceLookup = async ({ peerAccountId }) => {
      const response = await fetch(`${this.options.origin}/v1/member-questions/presence?accountId=${encodeURIComponent(peerAccountId)}`)
      const body = await response.json() as { online?: unknown }
      if (!response.ok || typeof body.online !== 'boolean') throw new Error('keyless presence lookup failed')
      return body.online ? 'online' : 'offline'
    }
  }

  /** Register presence and begin consuming ciphertext events. */
  async start(faces: {
    readonly receiver?: MemberQuestionReceiverService
    readonly sender?: MemberQuestionSenderService
  } = {}): Promise<void> {
    this.receiver = faces.receiver
    this.sender = faces.sender
    this.online = true
    await this.beat()
    this.armHeartbeat()
    this.loop = this.pollLoop()
  }

  /** Toggle this Installation's live lease without discarding its cursor or key. */
  async setOnline(online: boolean): Promise<void> {
    if (online === this.online) return
    this.online = online
    if (!online) {
      if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
      this.heartbeat = undefined
      await this.heartbeatTask
      await this.removePresence()
      return
    }
    await this.beat()
    this.armHeartbeat()
  }

  /** Stop this exact Installation and remove its live presence lease. */
  async stop(): Promise<void> {
    if (this.online) await this.setOnline(false)
    this.abort.abort()
    await this.loop
    this.key.fill(0)
  }

  /** Replace the provisional route identity with the signed-in Platform Account. */
  async rebindAccount(accountId: string): Promise<void> {
    if (accountId.length === 0) throw new TypeError('keyless member-question account id must be non-empty')
    if (accountId === this.accountId) return
    await this.removePresence()
    this.accountId = accountId
    await this.beat()
  }

  private async beat(): Promise<void> {
    const response = await fetch(`${this.options.origin}/v1/member-questions/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: this.accountId,
        installationId: this.options.installationId,
      }),
      signal: this.abort.signal,
    })
    if (!response.ok) throw new Error(`keyless presence heartbeat failed with HTTP ${String(response.status)}`)
  }

  private armHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      this.heartbeatTask = this.heartbeatTask.then(async () => {
        if (this.online) await this.beat()
      })
    }, this.options.heartbeatMs ?? 500)
  }

  private async removePresence(): Promise<void> {
    const response = await fetch(`${this.options.origin}/v1/member-questions/presence`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: this.options.installationId }),
    })
    if (!response.ok) throw new Error(`keyless presence removal failed with HTTP ${String(response.status)}`)
  }

  private async deliver(encoded: EncodedMemberQuestion & {
    toProjectMember: string
    projectId: ProjectId
    documents: readonly EncodedMemberQuestionDocument[]
  }): Promise<void> {
    const frames = [encoded.encoded, ...encoded.documents.flatMap(document => document.encoded)]
    const ciphertexts = frames.map((frame, index) => seal(
      this.key,
      frame,
      questionAad(encoded.questionId, index),
    ))
    const response = await fetch(`${this.options.origin}/v1/member-questions/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: encoded.questionId,
        projectId: encoded.projectId,
        fromAccountId: this.accountId,
        toAccountId: encoded.toProjectMember,
        ciphertexts,
      }),
      signal: this.abort.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`keyless question delivery failed with HTTP ${String(response.status)}: ${body}`)
    }
  }

  private async claimTerminal(
    terminal: CompanionMemberQuestionSettledResult,
  ): Promise<MemberQuestionTerminalClaim & ReceiverTerminalClaim> {
    const encoded = encodeCompanionMessage(PROTOCOL, { type: 'result', result: terminal })
    const response = await fetch(`${this.options.origin}/v1/member-questions/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: terminal.questionId,
        ciphertext: seal(this.key, encoded, terminalAad(terminal.questionId)),
      }),
      signal: this.abort.signal,
    })
    const body = await response.json() as { claimed?: unknown; ciphertext?: unknown }
    if (!response.ok || typeof body.claimed !== 'boolean' || typeof body.ciphertext !== 'string') {
      throw new Error(`keyless terminal claim failed with HTTP ${String(response.status)}`)
    }
    return { claimed: body.claimed, terminal: decodeTerminal(this.key, terminal.questionId, body.ciphertext) }
  }

  private async queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined> {
    const response = await fetch(`${this.options.origin}/v1/member-questions/terminal?questionId=${encodeURIComponent(questionId)}`)
    const body = await response.json() as { state?: unknown; ciphertext?: unknown }
    if (!response.ok) throw new Error(`keyless terminal query failed with HTTP ${String(response.status)}`)
    if (body.state === 'pending') return undefined
    if (body.state !== 'terminal' || typeof body.ciphertext !== 'string') throw new Error('keyless terminal query returned invalid JSON')
    return decodeTerminal(this.key, questionId, body.ciphertext)
  }

  private async pollLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      if (!this.online) {
        await delay(this.options.pollMs ?? 25, this.abort.signal)
        continue
      }
      try {
        await this.pollOnce()
      } catch (error) {
        if (this.abort.signal.aborted) return
        throw error
      }
      await delay(this.options.pollMs ?? 25, this.abort.signal)
    }
  }

  private async pollOnce(): Promise<void> {
    const url = new URL('/v1/member-questions/events', this.options.origin)
    url.searchParams.set('accountId', this.accountId)
    url.searchParams.set('installationId', this.options.installationId)
    url.searchParams.set('after', String(this.cursor))
    const response = await fetch(url, { signal: this.abort.signal })
    const body = await response.json() as { events?: unknown; cursor?: unknown }
    if (!response.ok || !Array.isArray(body.events) || !Number.isSafeInteger(body.cursor)) {
      throw new Error(`keyless event poll failed with HTTP ${String(response.status)}`)
    }
    for (const raw of body.events) await this.applyEvent(parseEvent(raw))
    this.cursor = body.cursor as number
  }

  private async applyEvent(event: BrokerEvent): Promise<void> {
    if (event.kind === 'question') {
      if (event.toAccountId !== this.accountId || this.receiver === undefined) return
      const decoded = event.ciphertexts.map((ciphertext, index) => decodeCompanionMessage(
        PROTOCOL,
        open(this.key, ciphertext, questionAad(event.questionId, index)),
      ))
      const first = decoded[0]
      if (first?.type !== 'operation' || first.operation.type !== 'member-question') {
        throw new Error('keyless delivery does not begin with a member-question operation')
      }
      const assembler = new MemberQuestionDocumentAssembler(
        first.operation.questionId,
        first.operation.references.map(reference => reference.path),
      )
      const documents = decoded.slice(1).flatMap((message) => {
        if (message.type !== 'operation' || message.operation.type !== 'document-chunk') {
          throw new Error('keyless delivery contains a non-document frame after its member question')
        }
        const complete = assembler.accept(message.operation)
        return complete === undefined ? [] : [complete]
      })
      if (documents.length !== first.operation.references.length) {
        throw new Error('keyless delivery ended before every reference document completed')
      }
      await this.receiver.ingest({
        authority: { accountId: this.accountId as PlatformAccountId },
        operation: first.operation,
        documents,
      })
      return
    }
    const terminal = decodeTerminal(this.key, event.questionId as MemberQuestionId, event.ciphertext)
    await this.sender?.applyTerminal(terminal)
    const receiver = this.receiver
    if (receiver === undefined) return
    const snapshot = await receiver.snapshot()
    if (!snapshot.pending.some(question => question.questionId === terminal.questionId)) return
    await receiver.settle(terminal.questionId, {
      kind: 'authoritative', claim: { claimed: false, terminal },
    })
  }
}

function parseEvent(value: unknown): BrokerEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('keyless broker event must be an object')
  const record = value as Record<string, unknown>
  if (record.kind === 'question'
    && typeof record.seq === 'number'
    && typeof record.questionId === 'string'
    && typeof record.projectId === 'string'
    && typeof record.fromAccountId === 'string'
    && typeof record.toAccountId === 'string'
    && Array.isArray(record.ciphertexts)
    && record.ciphertexts.every(item => typeof item === 'string')) {
    return record as unknown as BrokerQuestionEvent
  }
  if (record.kind === 'terminal'
    && typeof record.seq === 'number'
    && typeof record.questionId === 'string'
    && typeof record.ciphertext === 'string') {
    return record as unknown as BrokerTerminalEvent
  }
  throw new Error('keyless broker event is invalid')
}

function decodeTerminal(
  key: Uint8Array,
  questionId: MemberQuestionId,
  ciphertext: string,
): CompanionMemberQuestionSettledResult {
  const message = decodeCompanionMessage(PROTOCOL, open(key, ciphertext, terminalAad(questionId)))
  if (message.type !== 'result' || message.result.type !== 'member-question-settled') {
    throw new Error('keyless terminal ciphertext does not carry a member-question terminal')
  }
  return message.result
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return encodeProtocolBase64Url(Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]))
}

function open(key: Uint8Array, encoded: string, aad: string): Uint8Array {
  const envelope = decodeProtocolBase64Url(encoded, 128 * 1_024, 'keyless encrypted member-question frame')
  if (envelope.byteLength < 28) throw new Error('keyless encrypted frame is truncated')
  const nonce = envelope.slice(0, 12)
  const tag = envelope.slice(12, 28)
  const ciphertext = envelope.slice(28)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function questionAad(questionId: MemberQuestionId | string, index: number): string {
  return `member-question:${questionId}:${String(index)}`
}

function terminalAad(questionId: MemberQuestionId | string): string {
  return `member-question-terminal:${questionId}`
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
