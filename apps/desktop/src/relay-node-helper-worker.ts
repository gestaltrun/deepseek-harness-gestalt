/** System-Node WSS worker for Electron Desktop Relay transport. */

import WebSocket, { type RawData } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'

type ParentMessage =
  | { type: 'connect'; url: string; proxyUrl?: string }
  | { type: 'data'; value: Uint8Array }
  | { type: 'close' }

type WorkerMessage =
  | { type: 'open' }
  | { type: 'data'; value: Uint8Array }
  | { type: 'closed' }
  | { type: 'error'; code?: string; name?: string; stage: HelperFailureStage }

type HelperFailureStage = 'connect' | 'parent-message' | 'parent-send' | 'socket' | 'socket-send'

let socket: WebSocket | undefined
let opened = false
let settling = false

process.once('message', (value: unknown) => { connect(value) })
process.once('disconnect', () => {
  socket?.terminate()
  process.exit(0)
})

function connect(value: unknown): void {
  try {
    const message = parseConnect(value)
    const target = new URL(message.url)
    if (target.protocol !== 'wss:' || target.username !== '' || target.password !== '') {
      throw new TypeError('Relay helper target must be credential-free WSS')
    }
    const agent = message.proxyUrl === undefined ? undefined : proxyAgent(message.proxyUrl)
    const connected = new WebSocket(target, {
      perMessageDeflate: false,
      maxPayload: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
      ...(agent === undefined ? {} : { agent }),
    })
    socket = connected
    connected.on('message', (data) => {
      const value = bytes(data)
      if (!send({ type: 'data', value: Buffer.from(value) })) {
        connected.close(1009, 'relay helper backpressure')
      }
    })
    connected.once('open', () => {
      opened = true
      process.on('message', acceptParentMessage)
      if (!send({ type: 'open' })) connected.terminate()
    })
    connected.once('error', (error) => { fail(error, 'socket') })
    connected.once('close', () => { finishClosed() })
  } catch (error) {
    fail(error, 'connect')
  }
}

function acceptParentMessage(value: unknown): void {
  if (settling || socket === undefined) return
  let message: Exclude<ParentMessage, { type: 'connect' }>
  try { message = parseParentMessage(value) }
  catch (error) { fail(error, 'parent-message'); return }
  if (message.type === 'close') {
    settling = true
    socket.close()
    setTimeout(() => { socket?.terminate() }, 1_000).unref()
    return
  }
  if (socket.readyState !== WebSocket.OPEN) {
    fail(Object.assign(new Error('Relay helper socket is closed'), { code: 'ECONNRESET' }), 'parent-send')
    return
  }
  socket.send(message.value, { binary: true }, (error) => {
    if (error != null) fail(error, 'socket-send')
  })
}

function parseConnect(value: unknown): Extract<ParentMessage, { type: 'connect' }> {
  if (!isRecord(value) || value.type !== 'connect' || typeof value.url !== 'string'
    || (value.proxyUrl !== undefined && typeof value.proxyUrl !== 'string')) {
    throw new TypeError('Relay helper connect message is invalid')
  }
  return { type: 'connect', url: value.url, ...(value.proxyUrl === undefined ? {} : { proxyUrl: value.proxyUrl }) }
}

function parseParentMessage(value: unknown): Exclude<ParentMessage, { type: 'connect' }> {
  if (!isRecord(value)) throw new TypeError('Relay helper parent message is invalid')
  if (value.type === 'close') return { type: 'close' }
  if (value.type !== 'data' || !(value.value instanceof Uint8Array)
    || value.value.byteLength > REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('Relay helper parent data is invalid')
  }
  return { type: 'data', value: value.value }
}

function proxyAgent(value: string): HttpsProxyAgent<string> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new TypeError('Relay helper proxy must be credential-free HTTP or HTTPS')
  }
  return new HttpsProxyAgent(url)
}

function fail(error: unknown, stage: HelperFailureStage): void {
  if (settling) return
  settling = true
  socket?.terminate()
  const code = errorCode(error)
  const name = error instanceof Error && /^[A-Za-z]{1,64}$/u.test(error.name) ? error.name : undefined
  void sendAndExit({
    type: 'error',
    ...(code === undefined ? {} : { code }),
    ...(name === undefined ? {} : { name }),
    stage,
  }, 1)
}

function finishClosed(): void {
  if (!settling) settling = true
  void sendAndExit({ type: 'closed' }, opened ? 0 : 1)
}

function send(message: WorkerMessage): boolean {
  if (process.send === undefined || !process.connected) return false
  return process.send(message)
}

async function sendAndExit(message: WorkerMessage, code: number): Promise<void> {
  if (process.send !== undefined && process.connected) {
    await new Promise<void>((resolve) => {
      process.send?.(message, () => { resolve() })
    })
  }
  process.exit(code)
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(error.code)) return undefined
  return error.code
}

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const { buffer, byteOffset, byteLength } = data
  return new Uint8Array(buffer, byteOffset, byteLength)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
