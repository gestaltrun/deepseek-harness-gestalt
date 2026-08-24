/** WSS Consumer for the opaque Remote Access Relay capability. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { RemoteRelayError, type RemoteRelayAttachment } from '@deepseek-ai/dsh-remote-access'
import {
  decodeRelayMessage,
  encodeRelayMessage,
  parseRelayAttachChallengeId,
  relayAttachmentProofMatches,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
  type RelayErrorCode,
  type RelayErrorMessage,
  type RelayAttachChallengeMessage,
  type RelayAttachChallengeRequestMessage,
} from '@deepseek-ai/dsh-remote-protocol'
import z from '@deepseek-ai/schemastery'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

/** Deployment configuration for the outbound endpoint WSS route. */
export interface RelayWebSocketConfig {
  /** Exact Platform path owned by Remote Access. */
  path: string
  /** Maximum time from upgrade until the authenticated attach frame arrives. */
  attachTimeoutMs: number
  /** Maximum upgraded sockets allowed to retain an unanswered attach challenge. */
  maxPendingChallenges: number
}

/** Validated Relay WSS configuration with no deployment-specific defaults. */
export const Config: z<RelayWebSocketConfig> = z.object({
  path: z.string().required(),
  attachTimeoutMs: z.natural().min(1).required(),
  maxPendingChallenges: z.natural().min(1).required(),
})

/** Cordis plugin name for the Relay WSS Consumer. */
export const name = 'remote-access-relay-websocket'
/** Required Relay capability and Platform upgrade registry. */
export const inject = ['remoteRelay', 'webServer']

/** Register the exact Remote Access WSS endpoint. */
export function apply(ctx: Context, config: RelayWebSocketConfig): void {
  if (!config.path.startsWith('/') || config.path.length === 1 || config.path.endsWith('/')
    || config.path.includes('?') || config.path.includes('#')) {
    throw new TypeError('Remote Relay path must be an absolute non-root pathname without query, fragment, or trailing slash')
  }
  const consumer = new RelayWebSocketConsumer(ctx, config.attachTimeoutMs, config.maxPendingChallenges)
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: config.path,
    handler: (req, socket, head) => { consumer.handleUpgrade(req, socket, head) },
  }), 'remote-access: Relay WSS route')
  ctx.effect(() => async () => { await consumer.close() }, 'remote-access: Relay WSS connections')
}

/** Owns no-server WSS negotiation, protocol parsing, and attachment teardown. */
export class RelayWebSocketConsumer {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
    perMessageDeflate: false,
  })
  private readonly pumps = new Set<Promise<void>>()
  private readonly attachmentAborts = new Set<AbortController>()
  private pendingChallenges = 0

  /**
   * @param ctx - Remote Relay public service.
   * @param attachTimeoutMs - first-frame deadline.
   * @param maxPendingChallenges - pre-proof socket capacity.
   */
  constructor(
    private readonly ctx: Context,
    private readonly attachTimeoutMs: number,
    private readonly maxPendingChallenges: number,
  ) {
    if (!Number.isSafeInteger(attachTimeoutMs) || attachTimeoutMs <= 0) {
      throw new TypeError('Remote Relay attach timeout must be a positive integer')
    }
    if (!Number.isSafeInteger(maxPendingChallenges) || maxPendingChallenges <= 0) {
      throw new TypeError('Remote Relay pending challenge limit must be a positive integer')
    }
  }

  /**
   * Transfer one HTTP upgrade into the Relay WSS protocol owner.
   * @param req - accepted HTTP upgrade request.
   * @param socket - upgraded network stream.
   * @param head - bytes received after the HTTP upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => { this.accept(websocket) })
  }

  /** Terminate every socket and wait for all attachment cleanup. */
  async close(): Promise<void> {
    for (const controller of this.attachmentAborts) controller.abort(new Error('Relay WSS Consumer is closing'))
    for (const socket of this.server.clients) socket.terminate()
    const serverClose = new Promise<void>((resolve, reject) => {
      this.server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    const results = await Promise.allSettled([serverClose, ...this.pumps])
    this.pumps.clear()
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (errors.length > 0) throw new AggregateError(errors, 'Remote Relay WSS shutdown failed')
  }

  private accept(socket: WebSocket): void {
    if (this.pendingChallenges >= this.maxPendingChallenges) {
      socket.close(1013, 'pending challenge capacity')
      return
    }
    this.pendingChallenges += 1
    let pendingChallengeHeld = true
    const releasePendingChallenge = (): void => {
      if (!pendingChallengeHeld) return
      pendingChallengeHeld = false
      this.pendingChallenges -= 1
    }
    let attachment: RemoteRelayAttachment | undefined
    let challengeRequest: RelayAttachChallengeRequestMessage | undefined
    let challenge: RelayAttachChallengeMessage | undefined
    let failed = false
    let serial = Promise.resolve()
    const attachmentAbort = new AbortController()
    this.attachmentAborts.add(attachmentAbort)
    const attachTimer = setTimeout(() => {
      failed = true
      attachmentAbort.abort()
      socket.close(1008, 'attach timeout')
    }, this.attachTimeoutMs)
    attachTimer.unref()
    const settle = async (): Promise<void> => {
      clearTimeout(attachTimer)
      attachmentAbort.abort()
      try {
        if (attachment !== undefined) await attachment.close()
      } finally {
        releasePendingChallenge()
        this.attachmentAborts.delete(attachmentAbort)
      }
    }
    const pump = new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => {
        serial = serial.then(async () => {
          if (failed) return
          const message = decodeRelayMessage(bytes(data))
          if (attachment === undefined) {
            if (challenge === undefined) {
              if (message.type !== 'attach-challenge') {
                throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', 'Relay connection requires attachment challenge first')
              }
              challengeRequest = message
              challenge = {
                type: 'attach-challenge-response', transportVersion: 1,
                routeId: message.routeId, attachmentId: message.attachmentId, endpoint: message.endpoint,
                credentialPublicKey: message.credentialPublicKey,
                challengeId: parseRelayAttachChallengeId(randomUUID()),
                nonce: randomBytes(32),
                expiresAt: Date.now() + this.attachTimeoutMs,
              }
              await send(socket, encodeRelayMessage(challenge))
              return
            }
            if (message.type !== 'attach' || challengeRequest === undefined
              || !relayAttachmentProofMatches(challengeRequest, challenge, message)
              || Date.now() > challenge.expiresAt) {
              throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', 'Relay attachment proof does not match its live challenge')
            }
            attachment = await this.ctx.remoteRelay.attach({
              message,
              deliver: outgoing => send(socket, encodeRelayMessage(outgoing)),
              close: () => { socket.terminate() },
              signal: attachmentAbort.signal,
              announce: async (ready) => {
                await send(socket, encodeRelayMessage(ready))
              },
            })
            releasePendingChallenge()
            clearTimeout(attachTimer)
            return
          }
          if (message.type === 'ciphertext' || message.type === 'heartbeat') {
            await attachment.receive(message)
            return
          }
          throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', 'Relay connection message is invalid after attach')
        }).catch(async (error: unknown) => {
          if (failed) return
          const relayError = errorMessage(error)
          try { await send(socket, encodeRelayMessage(relayError)) } catch {
            // The socket is already gone, so no endpoint remains to receive the transport error.
          }
          if (attachment === undefined || relayError.code === 'RELAY_ATTACHMENT_REJECTED'
            || relayError.code === 'RELAY_ROUTE_REVOKED') {
            failed = true
            socket.close(1008, relayError.code)
          }
        })
      })
      socket.once('close', () => {
        void serial.then(settle).then(resolve, reject)
      })
      socket.once('error', () => {
        // The close event owns settlement and attachment cleanup.
      })
    })
    this.pumps.add(pump)
    void pump.then(
      () => { this.pumps.delete(pump) },
      () => {
        // A failed cleanup remains owned until close() observes it.
      },
    )
  }
}

function bytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function send(socket: WebSocket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Relay WebSocket closed before frame delivery'))
      return
    }
    socket.send(bytes, { binary: true }, (error) => { if (error == null) resolve(); else reject(error) })
  })
}

function errorMessage(error: unknown): RelayErrorMessage {
  if (error instanceof RemoteRelayError) {
    return {
      type: 'error', transportVersion: 1, code: error.code,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    }
  }
  const code: RelayErrorCode = error instanceof RemoteProtocolError && error.code === 'RELAY_TRANSPORT_INCOMPATIBLE'
    ? 'RELAY_TRANSPORT_INCOMPATIBLE'
    : 'RELAY_ATTACHMENT_REJECTED'
  return { type: 'error', transportVersion: 1, code }
}
