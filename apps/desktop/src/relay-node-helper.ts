/** Managed system-Node carrier for Desktop Relay WSS. */

import { fork, type ChildProcess } from 'node:child_process'
import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import {
  RelayInboundQueue,
  type RelayEndpointSocket,
  type RelayInboundQueueLimits,
} from '@deepseek-ai/dsh-remote-access-client'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { desktopNodeHelperEnvironment } from './node-helper-environment.ts'

type HelperMessage =
  | { type: 'open' }
  | { type: 'data'; value: Uint8Array }
  | { type: 'closed' }
  | { type: 'error'; code?: string; name?: string; stage: HelperFailureStage }

type HelperFailureStage = 'connect' | 'parent-message' | 'parent-send' | 'socket' | 'socket-send'

interface HelperExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface DesktopRelayNodeHelperOptions {
  nodePath: string
  helperPath: string
  url: string
  proxyUrl?: string
  signal: AbortSignal
  limits: RelayInboundQueueLimits
  /** Test-only TypeScript loader arguments. Production runs the bundled helper. */
  execArgv?: readonly string[]
  /** Test-only environment additions such as a local certificate authority. */
  environment?: Readonly<NodeJS.ProcessEnv>
}

/**
 * Open one Relay WSS carrier in the official Node runtime bundled beside Electron.
 * @param options - runtime paths, proxy candidate, lifecycle signal, and inbound bounds.
 * @returns connected socket whose child process is joined by {@link RelayEndpointSocket.close}.
 */
export async function connectDesktopRelayNodeHelper(
  options: DesktopRelayNodeHelperOptions,
): Promise<RelayEndpointSocket> {
  const child = fork(options.helperPath, [], {
    execPath: options.nodePath,
    execArgv: [...options.execArgv ?? []],
    env: desktopNodeHelperEnvironment(process.env, options.environment),
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr?.resume()
  const queue = new RelayInboundQueue(options.limits)
  const ready = deferred<void>()
  const closed = deferred<HelperExit>()
  let opened = false
  let gracefulClose = false
  let readySettled = false

  const settleReady = (action: () => void): void => {
    if (readySettled) return
    readySettled = true
    action()
  }
  const fail = (message: Extract<HelperMessage, { type: 'error' }>): void => {
    const error = Object.assign(new Error('Desktop Relay Node helper failed'), {
      ...(message.code === undefined ? {} : { code: message.code }),
    })
    settleReady(() => { ready.reject(error) })
    if (opened) {
      const transport = new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket failed')
      Object.defineProperty(transport, 'cause', {
        value: Object.assign(
          new Error(`Relay Node helper transport failed at ${message.stage}${message.name === undefined ? '' : `: ${message.name}`}`),
          message.code === undefined ? {} : { code: message.code },
        ),
      })
      queue.fail(transport)
    }
  }
  child.on('message', (value: unknown) => {
    let message: HelperMessage
    try { message = parseHelperMessage(value) }
    catch {
      fail({ type: 'error', stage: 'parent-message' })
      child.kill()
      return
    }
    if (message.type === 'open') {
      opened = true
      settleReady(() => { ready.resolve() })
      return
    }
    if (message.type === 'data') {
      try { queue.push(message.value) }
      catch {
        child.kill()
      }
      return
    }
    if (message.type === 'closed') {
      gracefulClose = true
      queue.end()
      return
    }
    fail(message)
  })
  child.once('error', () => {
    fail({ type: 'error', stage: 'socket' })
  })
  child.once('close', (code, signal) => {
    if (!gracefulClose && opened) queue.fail(new RemoteRelayError('REMOTE_OFFLINE', 'Relay Node helper exited'))
    if (!opened) settleReady(() => { ready.reject(new Error('Desktop Relay Node helper exited before opening')) })
    closed.resolve({ code, signal })
  })

  const onAbort = (): void => { child.kill() }
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) onAbort()
  try {
    await send(child, {
      type: 'connect', url: options.url,
      ...(options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
    })
    await ready.promise
  } catch (error) {
    child.kill()
    await closed.promise
    if (options.signal.aborted) {
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Desktop Relay Node helper acquisition was cancelled')
    }
    throw error
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
  return new DesktopRelayNodeHelperSocket(child, queue, closed.promise)
}

class DesktopRelayNodeHelperSocket implements RelayEndpointSocket {
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly child: ChildProcess,
    private readonly queue: RelayInboundQueue,
    private readonly closed: Promise<HelperExit>,
  ) {}

  async send(value: Uint8Array): Promise<void> {
    if (value.byteLength > REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
      throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay frame exceeds its wire byte limit')
    }
    await send(this.child, { type: 'data', value: Buffer.from(value) })
  }

  messages(): AsyncIterable<Uint8Array> { return this.queue }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      try { await send(this.child, { type: 'close' }) }
      catch { this.child.kill() }
      await this.closed
      this.queue.end()
    })()
  }
}

function send(child: ChildProcess, message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!child.connected) {
      reject(new RemoteRelayError('REMOTE_OFFLINE', 'Desktop Relay Node helper is closed'))
      return
    }
    child.send(message, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function parseHelperMessage(value: unknown): HelperMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new TypeError('Relay helper message is invalid')
  if (value.type === 'open' || value.type === 'closed') return { type: value.type }
  if (value.type === 'error') {
    if (value.code !== undefined && (typeof value.code !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(value.code))) {
      throw new TypeError('Relay helper error code is invalid')
    }
    if (value.name !== undefined && (typeof value.name !== 'string' || !/^[A-Za-z]{1,64}$/u.test(value.name))) {
      throw new TypeError('Relay helper error name is invalid')
    }
    if (!['connect', 'parent-message', 'parent-send', 'socket', 'socket-send'].includes(String(value.stage))) {
      throw new TypeError('Relay helper error stage is invalid')
    }
    return {
      type: 'error',
      ...(value.code === undefined ? {} : { code: value.code }),
      ...(value.name === undefined ? {} : { name: value.name }),
      stage: value.stage as HelperFailureStage,
    }
  }
  if (value.type !== 'data' || !(value.value instanceof Uint8Array)
    || value.value.byteLength > REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('Relay helper data is invalid')
  }
  return { type: 'data', value: new Uint8Array(value.value) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
