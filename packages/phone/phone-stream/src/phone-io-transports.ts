import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket } from 'ws'

type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown }
const OWNED_AGGREGATE = Symbol('phone-io-owned-aggregate')
type OwnedAggregate = AggregateError & { [OWNED_AGGREGATE]: true }
/** Package-private WebSocket server adapter. */
export interface PhoneIoServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ready: (peer: WebSocket) => void): void
  close(done: (error?: Error) => void): void
}
/** Package-private protocol rejection adapter. */
export interface PhoneIoTransportAdapter { reject(socket: Duplex): void }
/** Deterministic transport cleanup scope. */
export type TransportScope = { readonly subsystem: 'server' } | { readonly subsystem: 'connection'; readonly sequence: number }
/** Bounds one server or connection cleanup scope. */
export type TransportDeadline = (task: Promise<void>, scope: TransportScope) => Promise<'settled' | 'timeout'>
/** Independent transport failure and timeout diagnostics. */
export interface TransportDiagnostics {
  failure(scope: TransportScope, error: unknown): void
  timeout(scope: TransportScope): void
}
/** Dispatches one admitted WebSocket message under connection cancellation. */
export type PhoneIoDispatch = (peer: WebSocket, raw: unknown, signal: AbortSignal) => Promise<void>
interface TaskRecord {
  readonly sequence: number
  readonly outcome: Promise<Outcome>
}
interface Connection {
  readonly sequence: number
  readonly socket: Duplex
  readonly abort: AbortController
  readonly tasks: Map<number, TaskRecord>
  state: 'accepting' | 'stopping' | 'abandoned' | 'closed'
  stop(reason: unknown): Promise<Outcome>
}

/**
 * Owns WebSocket upgrade, connection cancellation, dispatch tasks, and bounded shutdown.
 * A dispatch rejection is a fatal transport defect.
 */
export class PhoneIoTransports {
  private state: 'accepting' | 'closing' | 'closed' = 'accepting'
  private sequence = 0
  private readonly connections = new Map<number, Connection>()
  private readonly serverTombstones = new Set<Promise<Outcome>>()
  private closeOutcome: Promise<Outcome> | undefined
  private closePromise: Promise<void> | undefined

  constructor(private readonly server: PhoneIoServer, private readonly adapter: PhoneIoTransportAdapter,
    private readonly deadline: TransportDeadline, private readonly diagnostics: TransportDiagnostics) {}

  /** Accept one raw upgrade into connection ownership.
   * @param req - Upgrade request.
   * @param socket - Raw socket owned after admission.
   * @param head - Bytes already read by the HTTP server.
   * @param dispatch - Message dispatcher; rejection is a fatal transport defect.
   * @returns true when upgrade handling was admitted.
   */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, dispatch: PhoneIoDispatch): boolean {
    if (this.state !== 'accepting') { this.reject(socket, { subsystem: 'connection', sequence: this.sequence + 1 }); return false }
    const sequence = ++this.sequence
    const abort = new AbortController()
    const tasks = new Map<number, TaskRecord>()
    let taskSequence = 0
    let peer: WebSocket | undefined
    let stopped: Promise<Outcome> | undefined
    const connection: Connection = {
      sequence, socket, abort, tasks, state: 'accepting',
      stop: () => Promise.resolve({ ok: true }),
    }
    const rawClosed = (): void => { void stop(new Error('phone io raw socket closed')) }
    const peerClosed = (): void => { void stop(new Error('phone io peer closed')) }
    const message = (raw: unknown): void => {
      if (connection.state !== 'accepting') return
      const scope: TransportScope = { subsystem: 'connection', sequence }
      let resolveTask!: (outcome: Outcome) => void
      const outcome = new Promise<Outcome>((resolve) => { resolveTask = resolve })
      const task: TaskRecord = { sequence: ++taskSequence, outcome }
      tasks.set(task.sequence, task)
      const openedPeer = peer
      if (openedPeer === undefined) { resolveTask({ ok: false, error: new Error('phone io peer is not open') }); return }
      void observe(() => dispatch(openedPeer, raw, abort.signal)).then(resolveTask)
      void outcome.then((result) => {
        if (!result.ok && !isExpectedCancellation(result.error, abort.signal)) {
          this.report(scope, result.error)
          if (connection.state === 'accepting') void this.close(new Error('phone io dispatcher failed'))
        }
        if (connection.state === 'accepting' && result.ok) tasks.delete(task.sequence)
      })
    }
    const stop = (reason: unknown): Promise<Outcome> => {
      if (stopped !== undefined) return stopped
      let resolveStopped!: (outcome: Outcome) => void
      stopped = new Promise<Outcome>((resolve) => { resolveStopped = resolve })
      connection.state = 'stopping'
      abort.abort(reason)
      socket.off('close', rawClosed)
      peer?.off('close', peerClosed)
      peer?.off('message', message)
      const stopFailures: unknown[] = []
      try { peer?.close() } catch (error) { stopFailures.push(error); this.report({ subsystem: 'connection', sequence }, error) }
      try { socket.destroy() } catch (error) { stopFailures.push(error); this.report({ subsystem: 'connection', sequence }, error) }
      const scope: TransportScope = { subsystem: 'connection', sequence }
      const underlying = joinDynamic(tasks, stopFailures, abort.signal)
      void boundedOutcome(underlying, this.deadline, scope, this.diagnostics, false).then((outcome) => {
        if (connection.state !== 'closed') {
          connection.state = 'abandoned'
          void underlying.then(() => {
            connection.state = 'closed'
            this.connections.delete(sequence)
          })
        }
        resolveStopped(outcome)
      })
      void underlying.then(() => {
        if (connection.state === 'stopping') {
          connection.state = 'closed'
          this.connections.delete(sequence)
        }
      })
      return stopped
    }
    connection.stop = stop
    this.connections.set(sequence, connection)
    socket.once('close', rawClosed)
    try {
      this.server.handleUpgrade(req, socket, head, (opened) => {
        if (connection.state !== 'accepting' || this.state !== 'accepting') {
          try { opened.close() } catch (error) { this.report({ subsystem: 'connection', sequence }, error) }
          return
        }
        peer = opened
        peer.on('close', peerClosed)
        peer.on('message', message)
      })
      return true
    } catch (error) {
      if (peer !== undefined) {
        void stop(error)
      } else {
        socket.off('close', rawClosed)
        this.connections.delete(sequence)
        connection.state = 'closed'
        abort.abort(error)
        this.reject(socket, { subsystem: 'connection', sequence })
      }
      this.report({ subsystem: 'connection', sequence }, error)
      return false
    }
  }

  /** Test-private ownership counts; not exported from the package root.
   * @returns active connection, task, and server tombstone counts.
   */
  ownershipSnapshot(): { readonly connections: number; readonly tasks: number; readonly serverTombstones: number } {
    let tasks = 0
    for (const connection of this.connections.values()) tasks += connection.tasks.size
    return { connections: this.connections.size, tasks, serverTombstones: this.serverTombstones.size }
  }

  /** Fence upgrades and return the exact memoized bounded close promise.
   * @param reason - Cancellation reason delivered to every connection.
   * @returns exact public close promise.
   */
  close(reason: unknown): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    let resolvePublic!: () => void
    let rejectPublic!: (error: unknown) => void
    this.closePromise = new Promise<void>((resolve, reject) => { resolvePublic = resolve; rejectPublic = reject })
    if (this.closeOutcome === undefined) {
      this.state = 'closing'
      let resolveClose!: (outcome: Outcome) => void
      this.closeOutcome = new Promise<Outcome>((resolve) => { resolveClose = resolve })
      const connections = [...this.connections.values()].sort((a, b) => a.sequence - b.sequence)
      const serverScope: TransportScope = { subsystem: 'server' }
      const serverSettled = observeCallback((done) =>{  this.server.close(done) })
      this.serverTombstones.add(serverSettled)
      const server = boundedOutcome(serverSettled, this.deadline, serverScope, this.diagnostics, false).then((outcome) => {
        void serverSettled.then((late) => {
          if (!late.ok) for (const error of outcomeErrors(late.error)) this.report(serverScope, error)
          this.serverTombstones.delete(serverSettled)
        })
        return outcome
      })
      const stops = connections.map(connection => connection.stop(reason))
      void Promise.all([server, ...stops]).then((outcomes) => {
        this.state = 'closed'
        const failures = outcomes.flatMap(outcome => outcome.ok ? [] : outcomeErrors(outcome.error))
        resolveClose(failures.length === 0
          ? { ok: true }
          : { ok: false, error: failures.length === 1 ? failures[0] : ownedAggregate(failures, 'phone io transport close failed') })
      })
    }
    void this.closeOutcome.then((outcome) => { if (outcome.ok) resolvePublic(); else rejectPublic(outcome.error) })
    return this.closePromise
  }

  private reject(socket: Duplex, scope: TransportScope): void {
    try { this.adapter.reject(socket) } catch (error) {
      try { socket.destroy() } catch (_destroyError) { /* only fallback raw destruction can fail;
      the adapter rejection remains the reported failure */ }
      this.report(scope, error)
    }
  }

  private report(scope: TransportScope, error: unknown): void {
    try { this.diagnostics.failure(scope, error) } catch (_diagnosticError) { /* only the injected diagnostic callback can fail;
    transport settlement remains authoritative */ }
  }
}

function isExpectedCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false
  if (error === signal.reason) return true
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'PHONE_ABORTED'
}

function observe(call: () => Promise<void>): Promise<Outcome> {
  try { return Promise.resolve(call()).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error })) }
  catch (error) { return Promise.resolve({ ok: false, error }) }
}
function observeCallback(register: (done: (error?: Error) => void) => void): Promise<Outcome> {
  return new Promise((resolve) => {
    let callbackOutcome: Outcome | undefined
    let returned = false
    const publish = (): void => { if (returned && callbackOutcome !== undefined) resolve(callbackOutcome) }
    try {
      register((error) => { callbackOutcome = error === undefined ? { ok: true } : { ok: false, error }; publish() })
      returned = true
      publish()
    } catch (error) {
      returned = true
      if (callbackOutcome === undefined || callbackOutcome.ok) resolve({ ok: false, error })
      else resolve({ ok: false, error: ownedAggregate([callbackOutcome.error, error], 'phone io server close failed') })
    }
  })
}
function ownedAggregate(errors: unknown[], message: string): OwnedAggregate {
  const aggregate = new AggregateError(errors, message) as OwnedAggregate
  aggregate[OWNED_AGGREGATE] = true
  return aggregate
}
function outcomeErrors(error: unknown): unknown[] {
  return isOwnedAggregate(error) ? error.errors.flatMap(outcomeErrors) : [error]
}
function isOwnedAggregate(error: unknown): error is OwnedAggregate {
  return error instanceof AggregateError && (error as Partial<OwnedAggregate>)[OWNED_AGGREGATE] === true
}
async function boundedOutcome(outcome: Promise<Outcome>, deadline: TransportDeadline, scope: TransportScope,
  diagnostics: TransportDiagnostics, reportFailure = true): Promise<Outcome> {
  const settled = outcome.then((result) => {
    if (reportFailure && !result.ok) {
      try { diagnostics.failure(scope, result.error) } catch (_diagnosticError) {
        /* Only the injected diagnostic callback can fail; cleanup settlement remains authoritative. */
      }
    }
  })
  try {
    if (await deadline(settled, scope) === 'timeout') {
      const error = new Error(`${scope.subsystem} transport cleanup timed out`)
      try { diagnostics.timeout(scope) } catch (_diagnosticError) { /* only the injected diagnostic callback can fail;
      cleanup settlement remains authoritative */ }
      void settled.then(() => {})
      return { ok: false, error }
    }
  } catch (error) {
    try { diagnostics.failure(scope, error) } catch (_diagnosticError) { /* only the injected diagnostic callback can fail;
    cleanup settlement remains authoritative */ }
    return { ok: false, error }
  }
  return await outcome
}
async function joinDynamic(tasks: Map<number, TaskRecord>, initialFailures: unknown[] = [], signal?: AbortSignal): Promise<Outcome> {
  const failures: unknown[] = [...initialFailures]
  let size = -1
  while (size !== tasks.size) {
    size = tasks.size
    for (const task of [...tasks.values()].sort((a, b) => a.sequence - b.sequence)) {
      const result = await task.outcome
      if (!result.ok && (signal === undefined || !isExpectedCancellation(result.error, signal))) failures.push(result.error)
    }
  }
  if (failures.length === 0) return { ok: true }
  return { ok: false, error: failures.length === 1 ? failures[0] : ownedAggregate(failures, 'phone io dispatch failed') }
}
