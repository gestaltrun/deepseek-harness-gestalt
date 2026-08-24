/** Mobile/Desktop Relay connection lifecycle with reconnect and no offline mutation queue. */

import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import {
  decodeRelayMessage,
  deriveRelayCredentialPublicKey,
  encodeRelayMessage,
  signRelayAttachmentChallenge,
  RemoteProtocolError,
  type RelayAttachmentId,
  type RelayCredential,
  type RelayReadyMessage,
  type RelayAttachChallengeMessage,
  type RelayPeerUpdateMessage,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

const MAX_RUNTIME_TIMER_DELAY_MS = 2_147_483_647

/** Stable Relay or encrypted-Companion failure safe for endpoint UI projection. */
export type RemoteRelayClientError = RemoteRelayError | RemoteProtocolError

/** One connected WSS carrier supplied by a native or browser adapter. */
export interface RelayEndpointSocket {
  /** Write one complete encoded Relay Transport message. */
  send(value: Uint8Array): Promise<void>
  /** Read complete encoded Relay Transport messages until socket loss. */
  messages(): AsyncIterable<Uint8Array>
  /** Close the physical socket and resolve after its read side ends. */
  close(): Promise<void>
}

/** Desktop lifecycle reasons that always make the paired route Remote Offline. */
export type DesktopRelayStopReason = 'window-close' | 'sleep' | 'quit' | 'mobile-access-disabled'

/** Construction inputs for one Mobile or Desktop outbound Relay endpoint. */
export interface RemoteRelayEndpointOptions {
  endpoint: 'mobile' | 'desktop'
  /** Current protected route authority; production storage remains endpoint-owned. */
  route(signal: AbortSignal): Promise<{ routeId: RelayRouteId; credential: RelayCredential }>
  /** Fresh live attachment id for every physical connection. */
  attachmentId(): RelayAttachmentId
  /** Open one outbound connection through the deployment's single Platform endpoint. */
  connect(signal: AbortSignal): Promise<RelayEndpointSocket>
  /** Validated heartbeat interval shorter than the Platform heartbeat timeout. */
  heartbeatIntervalMs: number
  /** Maximum wait for Platform to authenticate and register an attach frame. */
  attachTimeoutMs: number
  /** Local retry floor combined with a Platform capacity `retryAfterMs`. */
  reconnectDelayMs: number
  /** Desktop-only authoritative projection emitted after every successful attachment. */
  resynchronize?: (
    send: (targetAttachmentId: RelayAttachmentId, ciphertext: Uint8Array) => Promise<void>,
  ) => Promise<void>
  /** Endpoint-owned ciphertext receiver. */
  onCiphertext?: (
    ciphertext: Uint8Array,
    sourceAttachmentId: RelayAttachmentId,
    signal: AbortSignal,
  ) => void | Promise<void>
  /** Observer invoked after Platform acknowledges one physical attachment. */
  onConnectionReady?: (attachmentId: RelayAttachmentId) => void
  /** Route-bound opposite attachments authenticated by Relay credential records. */
  onPeerAttachments?: (message: RelayReadyMessage | RelayPeerUpdateMessage) => void | Promise<void>
  /** Observer invoked whenever an acknowledged physical attachment ends. */
  onConnectionLost?: (attachmentId: RelayAttachmentId) => void
  /** Content-free transport or protocol observer; capacity carries the effective reconnect delay. */
  onTransportError?: (error: RemoteRelayClientError) => void
  clock?: { now(): number }
}

interface ActiveConnection {
  socket: RelayEndpointSocket
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  close: Promise<void> | undefined
}

interface LifecycleOwner {
  readonly controller: AbortController
  readonly ready: Deferred<void>
  readonly stopped: Deferred<void>
  run: Promise<void>
  stop: Promise<void> | undefined
  connection: ActiveConnection | undefined
}

/** Reconnecting outbound endpoint; reconnect starts a new socket and never replays a mutation. */
export class RemoteRelayEndpointController {
  private owner: LifecycleOwner | undefined

  /** @param options - route authority, socket adapter, lifecycle tunables, and endpoint callbacks. */
  constructor(private readonly options: RemoteRelayEndpointOptions) {
    for (const [name, value] of [
      ['attachTimeoutMs', options.attachTimeoutMs],
      ['heartbeatIntervalMs', options.heartbeatIntervalMs],
      ['reconnectDelayMs', options.reconnectDelayMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Remote Relay ${name} must be a positive integer`)
      }
    }
    if (options.endpoint === 'desktop' && options.resynchronize === undefined) {
      throw new TypeError('Desktop Relay endpoint requires an authoritative resynchronize callback')
    }
  }

  /** Start the lifecycle and resolve after the first attached endpoint resynchronizes. */
  async start(): Promise<void> {
    while (true) {
      const current = this.owner
      if (current === undefined) {
        const owner: LifecycleOwner = {
          controller: new AbortController(),
          ready: deferred<void>(),
          stopped: deferred<void>(),
          run: Promise.resolve(),
          stop: undefined,
          connection: undefined,
        }
        this.owner = owner
        owner.run = this.runConnections(owner)
        void owner.run.catch(() => {
          // runConnections rejection is collected later by stopOwner's allSettled + throwRejected.
        })
        return owner.ready.promise
      }
      if (current.stop === undefined) return current.ready.promise
      await current.stopped.promise
    }
  }

  /**
   * Stop and drain the live socket; the optional reason remains local.
   * @param _reason - local Desktop lifecycle event that made the endpoint offline.
   */
  async stop(_reason?: DesktopRelayStopReason): Promise<void> {
    const owner = this.owner
    if (owner === undefined) return
    owner.stop ??= this.stopOwner(owner)
    await owner.stop
  }

  /**
   * Report current acknowledged attachment ownership.
   * @returns whether this lifecycle currently owns an acknowledged live attachment.
   */
  isConnected(): boolean {
    const owner = this.owner
    return owner !== undefined && owner.stop === undefined && owner.connection !== undefined
  }

  /**
   * Send only on the current live socket; offline operations are never retained or replayed.
   * @param targetAttachmentId - current peer attachment receiving the ciphertext.
   * @param ciphertext - bounded encrypted Companion Protocol frame.
   */
  async sendCiphertext(targetAttachmentId: RelayAttachmentId, ciphertext: Uint8Array): Promise<void> {
    const owner = this.owner
    const connection = owner?.connection
    if (owner === undefined || owner.stop !== undefined || connection === undefined) {
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Paired Desktop is Remote Offline')
    }
    await connection.socket.send(encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1,
      routeId: connection.routeId,
      sourceAttachmentId: connection.attachmentId,
      targetAttachmentId,
      ciphertext,
    }))
  }

  private async stopOwner(owner: LifecycleOwner): Promise<void> {
    owner.controller.abort()
    const connection = owner.connection
    owner.connection = undefined
    const results = await Promise.allSettled([
      connection === undefined ? Promise.resolve() : this.closeConnection(connection),
      owner.run,
    ])
    this.owner = undefined
    owner.stopped.resolve()
    throwRejected(results, 'Remote Relay stop failed')
  }

  private async runConnections(owner: LifecycleOwner): Promise<void> {
    let stopFailure: unknown
    const signal = owner.controller.signal
    while (!isAborted(signal)) {
      let reconnectDelayMs = this.options.reconnectDelayMs
      try {
        await this.runConnection(owner)
      } catch (error) {
        if (isAborted(signal)) {
          if (error instanceof ConnectionTeardownError) stopFailure = error.cause
          break
        }
        const retry = this.reconnectFailure(error)
        reconnectDelayMs = retry.delayMs
        this.observeError(retry.error)
      }
      if (!isAborted(signal)) await delay(reconnectDelayMs, signal)
    }
    owner.ready.reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay lifecycle stopped before attachment'))
    if (stopFailure !== undefined) throw errorFromUnknown(stopFailure)
  }

  private async runConnection(owner: LifecycleOwner): Promise<void> {
    const signal = owner.controller.signal
    const route = await this.options.route(signal)
    const socket = await this.options.connect(signal)
    const connection: ActiveConnection = {
      socket,
      routeId: route.routeId,
      attachmentId: this.options.attachmentId(),
      close: undefined,
    }
    if (isAborted(signal)) {
      await this.closeConnection(connection)
      return
    }
    const iterator = socket.messages()[Symbol.asyncIterator]()
    let heartbeat: Promise<void> = Promise.resolve()
    let attached = false
    const heartbeatAbort = new AbortController()
    try {
      const credentialPublicKey = await deriveRelayCredentialPublicKey(route.credential)
      await socket.send(encodeRelayMessage({
        type: 'attach-challenge', transportVersion: 1,
        routeId: route.routeId,
        attachmentId: connection.attachmentId,
        endpoint: this.options.endpoint,
        credentialPublicKey,
      }))
      const challenge = await this.awaitAttachChallenge(connection, credentialPublicKey, iterator, signal)
      await socket.send(encodeRelayMessage(await signRelayAttachmentChallenge(route.credential, challenge)))
      const ready = await this.awaitReady(connection, iterator, signal)
      /* v8 ignore next -- stop can win only in the microtask gap after the acknowledged wait settles. */
      if (isAborted(signal)) return
      owner.connection = connection
      attached = true
      await this.options.onPeerAttachments?.(ready)
      this.observeConnection(this.options.onConnectionReady, connection.attachmentId)
      if (this.options.endpoint === 'desktop') {
        await this.options.resynchronize?.((target, ciphertext) => this.sendCiphertext(target, ciphertext))
      }
      owner.ready.resolve()
      heartbeat = this.heartbeat(owner, connection, heartbeatAbort.signal)
      void heartbeat.catch(() => {
        // Abort during delay/send is the finally teardown; send failures surface via receive/stop.
      })
      while (!isAborted(signal)) {
        const next = await iterator.next()
        if (next.done || isAborted(signal)) break
        await this.receive(connection, next.value, signal)
      }
    } finally {
      heartbeatAbort.abort()
      if (owner.connection === connection) owner.connection = undefined
      if (attached) this.observeConnection(this.options.onConnectionLost, connection.attachmentId)
      const results = await Promise.allSettled([this.closeConnection(connection), heartbeat])
      const errors = rejectedReasons(results)
      if (errors.length > 0) {
        throw new ConnectionTeardownError(errors.length === 1
          ? errors[0]
          : new AggregateError(errors, 'Remote Relay connection teardown failed'))
      }
    }
  }

  private async awaitReady(
    connection: ActiveConnection,
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal,
  ): Promise<RelayReadyMessage> {
    const next = await withTimeout(
      iterator.next(),
      this.options.attachTimeoutMs,
      signal,
      () => new RemoteRelayError('REMOTE_OFFLINE', 'Platform did not acknowledge Relay attachment'),
    )
    if (next.done) throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay socket closed before attachment acknowledgement')
    const message = decodeRelayMessage(next.value)
    if (message.type === 'error') {
      throw new RemoteRelayError(message.code, `Remote Relay returned ${message.code}`, message.retryAfterMs)
    }
    if (message.type !== 'ready' || message.routeId !== connection.routeId
      || message.attachmentId !== connection.attachmentId) {
      throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay endpoint received an invalid attachment acknowledgement')
    }
    return message
  }

  private async awaitAttachChallenge(
    connection: ActiveConnection,
    credentialPublicKey: Awaited<ReturnType<typeof deriveRelayCredentialPublicKey>>,
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal,
  ): Promise<RelayAttachChallengeMessage> {
    const next = await withTimeout(iterator.next(), this.options.attachTimeoutMs, signal,
      () => new RemoteRelayError('REMOTE_OFFLINE', 'Platform did not issue a Relay attachment challenge'))
    if (next.done) throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay socket closed before attachment challenge')
    const message = decodeRelayMessage(next.value)
    if (message.type === 'error') throw new RemoteRelayError(message.code, `Remote Relay returned ${message.code}`, message.retryAfterMs)
    if (message.type !== 'attach-challenge-response' || message.routeId !== connection.routeId
      || message.attachmentId !== connection.attachmentId || message.endpoint !== this.options.endpoint
      || message.credentialPublicKey !== credentialPublicKey
      || message.expiresAt <= (this.options.clock?.now() ?? Date.now())) {
      throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay endpoint received an invalid attachment challenge')
    }
    return message
  }

  private async heartbeat(owner: LifecycleOwner, connection: ActiveConnection, signal: AbortSignal): Promise<void> {
    while (!isAborted(signal) && owner.connection === connection) {
      await delay(this.options.heartbeatIntervalMs, signal)
      if (isAborted(signal) || owner.connection !== connection) return
      await connection.socket.send(encodeRelayMessage({
        type: 'heartbeat', transportVersion: 1,
        attachmentId: connection.attachmentId,
        sentAt: this.options.clock?.now() ?? Date.now(),
      }))
    }
  }

  private async receive(connection: ActiveConnection, encoded: Uint8Array, signal: AbortSignal): Promise<void> {
    const message = decodeRelayMessage(encoded)
    if (message.type === 'ciphertext') {
      if (message.routeId !== connection.routeId || message.targetAttachmentId !== connection.attachmentId) {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay ciphertext does not belong to this attachment')
      }
      await this.options.onCiphertext?.(message.ciphertext, message.sourceAttachmentId, signal)
      return
    }
    if (message.type === 'peer-update') {
      if (message.routeId !== connection.routeId || message.attachmentId !== connection.attachmentId) {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay peer update does not belong to this attachment')
      }
      await this.options.onPeerAttachments?.(message)
      return
    }
    if (message.type === 'error') {
      const error = new RemoteRelayError(message.code, `Remote Relay returned ${message.code}`, message.retryAfterMs)
      if (message.code === 'REMOTE_OFFLINE' || message.code === 'PLATFORM_CAPACITY') {
        this.observeError(error)
        return
      }
      throw error
    }
    throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay endpoint received an invalid server message')
  }

  private closeConnection(connection: ActiveConnection): Promise<void> {
    return connection.close ??= connection.socket.close()
  }

  private observeError(error: unknown): void {
    try {
      this.options.onTransportError?.(error instanceof RemoteRelayError || error instanceof RemoteProtocolError
        ? error
        : new RemoteRelayError('REMOTE_OFFLINE', 'Relay connection was lost'))
    } catch {
      // Transport observers cannot own or interrupt the Relay lifecycle.
    }
  }

  private reconnectFailure(error: unknown): { error: unknown; delayMs: number } {
    if (!(error instanceof RemoteRelayError) || error.code !== 'PLATFORM_CAPACITY') {
      return { error, delayMs: this.options.reconnectDelayMs }
    }
    const delayMs = Math.max(this.options.reconnectDelayMs, error.retryAfterMs ?? 0)
    return {
      error: error.retryAfterMs === delayMs
        ? error
        : new RemoteRelayError(error.code, error.message, delayMs),
      delayMs,
    }
  }

  private observeConnection(
    observer: ((attachmentId: RelayAttachmentId) => void) | undefined,
    attachmentId: RelayAttachmentId,
  ): void {
    try {
      observer?.(attachmentId)
    } catch {
      // Connection observers cannot own or interrupt the Relay lifecycle.
    }
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  let remaining = milliseconds
  while (remaining > MAX_RUNTIME_TIMER_DELAY_MS && !signal.aborted) {
    await timerDelay(MAX_RUNTIME_TIMER_DELAY_MS, signal)
    remaining -= MAX_RUNTIME_TIMER_DELAY_MS
  }
  if (!signal.aborted) await timerDelay(remaining, signal)
}

function timerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal: AbortSignal,
  timeoutError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { finish(() => { reject(timeoutError()) }) }, milliseconds)
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => { finish(() => { reject(errorFromUnknown(error)) }) },
    )
    function aborted(): void {
      finish(() => { reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay lifecycle stopped before attachment')) })
    }
    function finish(settle: () => void): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      settle()
    }
  })
}

function throwRejected(results: PromiseSettledResult<unknown>[], message: string): void {
  const errors = rejectedReasons(results)
  if (errors.length > 0) throw new AggregateError(errors, message)
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]): Error[] {
  const errors: Error[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(errorFromUnknown(result.reason))
  }
  return errors
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}

class ConnectionTeardownError extends Error {
  constructor(override readonly cause: unknown) {
    super('Remote Relay connection teardown failed')
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
