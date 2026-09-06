/**
 * Internal Host-owned pool of the shared external mobilecli generation.
 * Occupancy handles are distinct per acquire. The pool owns each Adapter `stop`.
 * Isolated iOS acquire is not wired: HOME/set/bind isolation does not exist yet.
 * Callers never receive ports, process ids, HOME paths, CoreSimulator sets, or Session ids.
 * This Module does not enroll native trees after Host SIGKILL; #574 is not complete.
 * @module @deepseek-ai/dsh-phone-runtime/runtime-pool
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { PhoneDevicesError } from './errors.ts'
import type {
  DeviceId,
  PhoneAgentInstallOptions,
  PhoneAgentInstallResult,
  PhoneAgentStatus,
  PhoneCaptureRequest,
  PhoneCaptureStream,
  PhoneDeviceChange,
  PhoneDeviceList,
  PhoneIoRequest,
  PhoneScreenshot,
} from './types.ts'

/** Private branded identity of one pool slot. Not a Session id. */
export type PhoneRuntimeSlot = Branded<'PhoneRuntimeSlot'>

/** Private branded identity of one occupancy. Not a Session id and not a slot. */
export type PhoneRuntimeOccupancyId = Branded<'PhoneRuntimeOccupancyId'>

/** Kind of generation the pool may hold. */
export type PhoneRuntimeKind = 'external' | 'isolated-ios'

/**
 * Admission lifecycle. `closed` means new acquire is rejected, not that start/stop
 * work has finished. Unresolved start and late `stop` stay in `cleanupPending`.
 */
export type PhoneRuntimePoolPhase = 'open' | 'closing' | 'closed'

/** Per-slot Adapter input. Provenance is Host-owned; never a raw Session id. */
export interface PhoneRuntimeSlotConfig {
  /** Why this slot exists: shared Host fleet or one isolated iOS generation. */
  readonly provenance: 'host-external' | 'host-isolated-ios'
  /** Absolute mobilecli path selected for this slot, when already resolved. */
  readonly executablePath?: string
  /** Non-sensitive SDK/AVD environment for this slot only. */
  readonly environment?: Readonly<Record<string, string>>
}

/** One generation's fleet operations. The pool owns stop; this type has no dispose. */
export interface PhoneRuntimeGeneration {
  /** Fetch the listing owned by this generation only. */
  listDevices(signal?: AbortSignal): Promise<PhoneDeviceList>
  /** Boot one simulator or emulator on this generation. */
  boot(id: DeviceId, signal?: AbortSignal): Promise<void>
  /** Shut down one simulator or emulator on this generation. */
  shutdown(id: DeviceId, signal?: AbortSignal): Promise<void>
  /** Execute one semantic action on this generation. */
  io(request: PhoneIoRequest, signal?: AbortSignal): Promise<void>
  /** Open capture on this generation. */
  startCapture(request: PhoneCaptureRequest): Promise<PhoneCaptureStream>
  /** Capture one PNG still on this generation. */
  screenshot(id: DeviceId, signal?: AbortSignal): Promise<PhoneScreenshot>
  /** Read on-device agent status on this generation. */
  agentStatus(id: DeviceId, signal?: AbortSignal): Promise<PhoneAgentStatus>
  /** Install or re-sign the on-device agent on this generation. */
  installAgent(id: DeviceId, options?: PhoneAgentInstallOptions): Promise<PhoneAgentInstallResult>
  /** Whether this generation currently accepts fleet operations. */
  isReady(): boolean
  /** Subscribe to readiness. Caller owns the returned unsubscribe; adapter contains listener exceptions. */
  onReadinessChanged(listener: (ready: boolean) => void): () => void
  /** Subscribe to listing deltas. Caller owns the returned unsubscribe; adapter contains subscriber exceptions. */
  onChanged(sub: (change: PhoneDeviceChange) => void): () => void
}

/**
 * Adapter start result. `stop` terminates exactly this child.
 * Publication and route authority close inside `stop` before abort and kill.
 */
export interface PhoneRuntimeStart {
  /** Fleet operations for the started child. */
  readonly generation: PhoneRuntimeGeneration
  /**
   * Stop exactly this child, never a slot's replacement. The adapter closes
   * subscriptions, notifications and route authority before abort/kill, then
   * resolves only after child cleanup completes; rejection reports failure,
   * not quiescence. Cancellation must not report unfinished cleanup as success.
   * The pool invokes this once and retains its original Promise outcome through
   * caller timeouts; the adapter need not memoize it. Late start uses this stop too.
   */
  stop(signal?: AbortSignal): Promise<void>
}

/** Request the Adapter uses to start one generation. */
export interface PhoneRuntimeSpawnRequest {
  readonly slot: PhoneRuntimeSlot
  readonly kind: PhoneRuntimeKind
  /** Fused acquire/dispose/replace cancellation. Adapter may ignore it. */
  readonly signal: AbortSignal
  /** Per-slot private config. Not a Session id. */
  readonly config: PhoneRuntimeSlotConfig
}

/** Adapter that starts one generation and returns that child's stop. */
export interface PhoneRuntimeAdapter {
  /**
   * Start one generation for the given slot.
   * @param request - Slot, kind, abort signal, and private config.
   * @returns the generation and the stop bound to that child.
   */
  start(request: PhoneRuntimeSpawnRequest): Promise<PhoneRuntimeStart>
}

/**
 * Occupancy handle. Operations read the cell generation only while this
 * occupancy is live and `epoch` matches the cell. They never hop to a replacement.
 */
export interface PhoneRuntimeHandle extends PhoneRuntimeGeneration {
  /** Occupancy minted for this acquire. */
  readonly occupancyId: PhoneRuntimeOccupancyId
  /**
   * Drop this occupancy only; repeated and reentrant calls share one Promise.
   * Last occupancy cleanup waits at most cleanupTimeoutMs. Resolution can leave
   * cleanupPending; stop failures are contained in lifecycle().cleanupFailures.
   * Releasing an old epoch never stops its replacement. No cancellation input.
   */
  release(): Promise<void>
}

/** Host-owned external occupancy core. Isolated acquire is unavailable until an isolation provider exists. */
export interface PhoneRuntimePool {
  /** Mint a new external occupancy. Joins the Host-lifetime external generation. */
  acquireExternal(signal?: AbortSignal): Promise<PhoneRuntimeHandle>
  /**
   * Isolated iOS acquire. This subset rejects until a private HOME/set/bind
   * isolation provider exists. Never falls back to the external generation.
   */
  acquireIsolatedIos(signal?: AbortSignal): Promise<PhoneRuntimeHandle>
  /**
   * Abort old occupancies, await their instance stop, then start a new epoch.
   * No cleanup budget bounds this wait. A pre-aborted signal rejects without
   * mutation; stop/start failure rejects. Cancellation after start entry may
   * resolve after stopping the late child with no replacement installed, so
   * resolution does not guarantee readiness. Returns no occupancy handle.
   */
  replaceExternal(request: {
    executablePath: string
    environment?: Readonly<Record<string, string>>
    signal?: AbortSignal
  }): Promise<void>
  /**
   * Stop the external child without last-release. Occupancies stay live.
   * Operations reject `PHONE_UNRESOLVED`. The next start bumps epoch and aborts
   * those ids; callers must `acquireExternal` again. Does not autostart.
   * A pre-aborted signal rejects without mutation. Start/stop ownership remains
   * available to dispose, including an already-rejected stop result.
   */
  stopExternal(signal?: AbortSignal): Promise<void>
  /**
   * Close admission, abort occupancies and bound cleanup by cleanupTimeoutMs.
   * Repeated and reentrant calls share one Promise; there is no caller signal.
   * Failures of retained published-generation stop Promises collected within
   * the budget reject (multiple failures use AggregateError). Budget expiry
   * resolves with cleanupPending; subsequent stop failures are recorded.
   * Late-start and late-child cleanup failures are recorded in
   * lifecycle().cleanupFailures whether or not dispose has settled.
   * Admission-closed is not quiescent,
   * and zero pending work does not imply successful child termination.
   */
  dispose(): Promise<void>
  /**
   * Internal owner facts. `closed` is admission-closed. `cleanupPending` includes
   * unresolved Adapter start as well as late instance `stop`. `cleanupFailures`
   * retains late stop/start failures after the dispose Promise has already settled.
   */
  lifecycle(): {
    readonly phase: PhoneRuntimePoolPhase
    readonly cleanupPending: number
    readonly cleanupFailures: readonly string[]
  }
}

/** Options for {@link createPhoneRuntimePool}. */
export interface PhoneRuntimePoolOptions {
  /** Finite milliseconds raced against Adapter start/stop during last-release and dispose. */
  readonly cleanupTimeoutMs: number
  /** Optional executable recorded as external-slot provenance until `replaceExternal`. */
  readonly executablePath?: string
  /** Optional environment recorded as external-slot provenance until `replaceExternal`. */
  readonly environment?: Readonly<Record<string, string>>
}

type OccupancyState = 'pending' | 'live' | 'released' | 'aborted'
type CellPhase = 'empty' | 'starting' | 'ready' | 'replacing' | 'stopping' | 'cleanupPending'

interface OccupancyRecord {
  readonly id: PhoneRuntimeOccupancyId
  readonly epoch: number
  state: OccupancyState
  readonly waiter: PromiseWithResolvers<PhoneRuntimeHandle>
}

interface Cell {
  readonly slot: PhoneRuntimeSlot
  readonly kind: PhoneRuntimeKind
  epoch: number
  phase: CellPhase
  unresolved: boolean
  config: PhoneRuntimeSlotConfig
  readonly occupancies: Map<PhoneRuntimeOccupancyId, OccupancyRecord>
  generation: PhoneRuntimeGeneration | undefined
  stop: ((signal?: AbortSignal) => Promise<void>) | undefined
  startAbort: AbortController
  startWork: Promise<void> | undefined
  startError: unknown
  cleanupWork: Promise<void> | undefined
  readonly starts: Set<Promise<void>>
  readonly stops: Set<() => Promise<void>>
}

interface PoolState {
  phase: PhoneRuntimePoolPhase
  cleanupPending: number
  readonly cleanupFailures: string[]
  disposeWork: Promise<void> | undefined
  seq: number
  external: Cell
  readonly isolated: Map<PhoneRuntimeSlot, Cell>
}

/** Bounded late-cleanup failure messages retained after admission is closed. */
const CLEANUP_FAILURE_LIMIT = 8

/**
 * Brand one private pool slot.
 * @param value - Opaque slot token minted by the pool.
 * @returns the branded slot.
 */
export function phoneRuntimeSlot(value: string): PhoneRuntimeSlot {
  return value as PhoneRuntimeSlot
}

/**
 * Brand one occupancy id.
 * @param value - Opaque occupancy token minted by the pool.
 * @returns the branded occupancy id.
 */
export function phoneRuntimeOccupancyId(value: string): PhoneRuntimeOccupancyId {
  return value as PhoneRuntimeOccupancyId
}

/**
 * Create the external occupancy core. Isolated acquire is unavailable until a
 * private isolation provider exists. Live `PhoneDevices` is not extracted;
 * native Host-death containment is unmet.
 *
 * @param adapter - Starts one generation and returns that child's stop.
 * @param options - Finite cleanup budget and optional external provenance.
 * @returns the pool.
 */
export function createPhoneRuntimePool(
  adapter: PhoneRuntimeAdapter,
  options: PhoneRuntimePoolOptions,
): PhoneRuntimePool {
  if (!Number.isSafeInteger(options.cleanupTimeoutMs) || options.cleanupTimeoutMs < 1) {
    throw new Error('phone-runtime pool: cleanupTimeoutMs must be a positive safe integer')
  }
  const cleanupTimeoutMs = options.cleanupTimeoutMs
  const state: PoolState = {
    phase: 'open',
    cleanupPending: 0,
    cleanupFailures: [],
    disposeWork: undefined,
    seq: 0,
    external: newCell(
      phoneRuntimeSlot('external'),
      'external',
      slotConfig('host-external', options.executablePath, options.environment),
    ),
    isolated: new Map(),
  }

  const mintId = (prefix: string): string => {
    state.seq += 1
    return `${prefix}:${String(state.seq)}`
  }

  const assertOpen = (): void => {
    if (state.phase !== 'open') {
      throw new PhoneDevicesError('PHONE_DISPOSED', 'the phone runtime pool is closed')
    }
  }

  const recordCleanupFailure = (error: unknown): void => {
    state.cleanupFailures.push(asError(error).message)
    if (state.cleanupFailures.length > CLEANUP_FAILURE_LIMIT) state.cleanupFailures.shift()
  }

  const lifecycle = (): {
    readonly phase: PhoneRuntimePoolPhase
    readonly cleanupPending: number
    readonly cleanupFailures: readonly string[]
  } => ({
    phase: state.phase,
    cleanupPending: state.cleanupPending,
    cleanupFailures: [...state.cleanupFailures],
  })

  const bindHandle = (cell: Cell, occupancy: OccupancyRecord): PhoneRuntimeHandle => {
    let releaseWork: Promise<void> | undefined
    const release = (): Promise<void> => {
      if (releaseWork !== undefined) return releaseWork
      const completion = Promise.withResolvers<void>()
      releaseWork = completion.promise
      completion.resolve(releaseOccupancy(cell, occupancy))
      return releaseWork
    }
    const run = <T>(op: (generation: PhoneRuntimeGeneration) => T): T => {
      const current = cell.occupancies.get(occupancy.id)
      if (current === undefined || current.state === 'released') {
        throw new PhoneDevicesError('PHONE_DISPOSED', 'the phone runtime occupancy was released')
      }
      if (current.state === 'aborted' || current.epoch !== cell.epoch) {
        throw new PhoneDevicesError('PHONE_ABORTED', 'the phone runtime occupancy was aborted')
      }
      if (cell.unresolved || cell.generation === undefined) {
        throw new PhoneDevicesError('PHONE_UNRESOLVED', 'the phone runtime generation is not prepared')
      }
      return op(cell.generation)
    }
    return {
      occupancyId: occupancy.id,
      release,
      listDevices: async signal => run(generation => generation.listDevices(signal)),
      boot: async (id, signal) => run(generation => generation.boot(id, signal)),
      shutdown: async (id, signal) => run(generation => generation.shutdown(id, signal)),
      io: async (request, signal) => run(generation => generation.io(request, signal)),
      startCapture: async request => run(generation => generation.startCapture(request)),
      screenshot: async (id, signal) => run(generation => generation.screenshot(id, signal)),
      agentStatus: async (id, signal) => run(generation => generation.agentStatus(id, signal)),
      installAgent: async (id, installOptions) => run(generation => generation.installAgent(id, installOptions)),
      isReady: () => {
        try {
          return run(generation => generation.isReady())
        } catch (error) {
          if (error instanceof PhoneDevicesError && error.code === 'PHONE_UNRESOLVED') return false
          throw error
        }
      },
      onReadinessChanged: listener => run(generation => generation.onReadinessChanged(listener)),
      onChanged: sub => run(generation => generation.onChanged(sub)),
    }
  }

  const publishOccupancy = (cell: Cell, epoch: number, signal: AbortSignal | undefined): OccupancyRecord => {
    const occupancy: OccupancyRecord = {
      id: phoneRuntimeOccupancyId(mintId('occ')),
      epoch,
      state: cell.phase === 'ready' && cell.generation !== undefined && !cell.unresolved ? 'live' : 'pending',
      waiter: Promise.withResolvers<PhoneRuntimeHandle>(),
    }
    cell.occupancies.set(occupancy.id, occupancy)
    const onAbort = (): void => {
      if (occupancy.state !== 'pending') return
      occupancy.state = 'aborted'
      occupancy.waiter.reject(new PhoneDevicesError('PHONE_ABORTED', 'phone runtime acquire was cancelled'))
      void occupancy.waiter.promise.catch(() => {})
      cell.occupancies.delete(occupancy.id)
      if (liveOrPending(cell) === 0) void lastRelease(cell)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    occupancy.waiter.promise.catch(() => {})
    if (occupancy.state === 'live') occupancy.waiter.resolve(bindHandle(cell, occupancy))
    return occupancy
  }

  const beginStart = (cell: Cell, retainWithoutOccupancy = false): void => {
    const epoch = cell.epoch
    const startAbort = cell.startAbort
    cell.phase = 'starting'
    cell.unresolved = false
    cell.startError = undefined
    cell.cleanupWork = undefined
    const work = Promise.resolve().then(async () => {
      let started: PhoneRuntimeStart
      try {
        started = await adapter.start({
          slot: cell.slot,
          kind: cell.kind,
          signal: startAbort.signal,
          config: cell.config,
        })
      } catch (error) {
        if (cell.epoch !== epoch || state.phase === 'closed' || cell.phase === 'cleanupPending') {
          recordCleanupFailure(error)
          return
        }
        cell.startError = error
        failStart(cell, error)
        return
      }
      const stale = cell.epoch !== epoch
        || startAbort.signal.aborted
      const abandoned = liveOrPending(cell) === 0 && !retainWithoutOccupancy
      if (stale || abandoned) {
        await containLate(started)
        if (cell.epoch === epoch && cell.phase !== 'cleanupPending') {
          cell.generation = undefined
          cell.stop = undefined
          cell.phase = 'empty'
        }
        return
      }
      cell.generation = started.generation
      cell.stop = memoizeStop(started)
      cell.stops.add(cell.stop)
      cell.phase = 'ready'
      cell.unresolved = false
      for (const occupancy of cell.occupancies.values()) {
        if (occupancy.epoch !== epoch || occupancy.state !== 'pending') continue
        occupancy.state = 'live'
        occupancy.waiter.resolve(bindHandle(cell, occupancy))
      }
    })
    cell.startWork = work
    cell.starts.add(work)
    void work.then(() => { cell.starts.delete(work) })
  }

  const failStart = (cell: Cell, error: unknown): void => {
    const failure = error instanceof PhoneDevicesError
      ? error
      : new PhoneDevicesError(
        'PHONE_UNAVAILABLE',
        error instanceof Error ? error.message : 'phone runtime start failed',
        { cause: error },
      )
    for (const occupancy of [...cell.occupancies.values()]) {
      if (occupancy.state !== 'pending') continue
      occupancy.state = 'aborted'
      occupancy.waiter.reject(failure)
      void occupancy.waiter.promise.catch(() => {})
      cell.occupancies.delete(occupancy.id)
    }
    cell.generation = undefined
    cell.stop = undefined
    cell.startWork = undefined
    cell.phase = 'empty'
    cell.unresolved = false
  }

  const containLate = async (started: PhoneRuntimeStart): Promise<void> => {
    try {
      await started.stop()
    } catch (error) {
      recordCleanupFailure(error)
    }
  }

  const raceCleanup = async (work: Promise<void>): Promise<'settled' | 'pending'> => {
    const budget = deadline(undefined, cleanupTimeoutMs, 'PHONE_TIMEOUT')
    try {
      const winner = await Promise.race([
        work.then(() => 'settled' as const),
        abortPending(budget.signal),
      ])
      return winner
    } finally {
      budget[Symbol.dispose]()
    }
  }

  const abortPending = async (signal: AbortSignal): Promise<'pending'> => {
    await new Promise<void>((resolveWait) => {
      signal.addEventListener('abort', () => {
        resolveWait()
      }, { once: true })
    })
    return 'pending'
  }

  const cleanupCell = (cell: Cell): Promise<void> => {
    if (cell.cleanupWork !== undefined) return cell.cleanupWork
    const completion = Promise.withResolvers<void>()
    cell.cleanupWork = completion.promise
    const starts = [...cell.starts]
    const stops = [...cell.stops]
    cell.phase = 'stopping'
    cell.generation = undefined
    cell.startAbort.abort()
    completion.resolve((async () => {
      const failures: Error[] = []
      const cleanup = Promise.allSettled([...starts, ...stops.map(stop => stop())]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') failures.push(asError(result.reason))
        }
        for (const stop of stops) cell.stops.delete(stop)
      })
      const raced = await raceCleanup(cleanup)
      if (raced === 'pending') {
        cell.phase = 'cleanupPending'
        state.cleanupPending += 1
        void cleanup.then(() => {
          for (const failure of failures) recordCleanupFailure(failure)
          settleCellCleanup(cell)
        })
        return
      }
      cell.stop = undefined
      cell.startWork = undefined
      cell.phase = 'empty'
      if (failures.length > 1) throw new AggregateError(failures, 'phone runtime cell cleanup failed')
      if (failures[0] !== undefined) throw failures[0]
    })())
    return cell.cleanupWork
  }

  const lastRelease = async (cell: Cell): Promise<void> => {
    try {
      await cleanupCell(cell)
    } catch (error) {
      recordCleanupFailure(error)
    }
  }

  const releaseOccupancy = async (cell: Cell, occupancy: OccupancyRecord): Promise<void> => {
    occupancy.state = 'released'
    cell.occupancies.delete(occupancy.id)
    if (occupancy.epoch !== cell.epoch) return
    if (liveOrPending(cell) === 0) await lastRelease(cell)
  }

  const acquireOnCell = async (cell: Cell, signal?: AbortSignal): Promise<PhoneRuntimeHandle> => {
    assertOpen()
    if (signal?.aborted === true) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime acquire was cancelled')
    }
    if (cell.phase === 'stopping' || cell.phase === 'cleanupPending') {
      throw new PhoneDevicesError('PHONE_ABORTED', 'the phone runtime generation is stopping')
    }
    if (cell.unresolved) {
      abortEpoch(cell)
      cell.unresolved = false
      cell.epoch += 1
      cell.startAbort = new AbortController()
      const occupancy = publishOccupancy(cell, cell.epoch, signal)
      beginStart(cell)
      return await occupancy.waiter.promise
    }
    if (cell.phase === 'empty') {
      cell.epoch += 1
      cell.startAbort = new AbortController()
      const occupancy = publishOccupancy(cell, cell.epoch, signal)
      beginStart(cell)
      return await occupancy.waiter.promise
    }
    if (cell.phase === 'starting' || cell.phase === 'replacing') {
      const occupancy = publishOccupancy(cell, cell.epoch, signal)
      return await occupancy.waiter.promise
    }
    const occupancy = publishOccupancy(cell, cell.epoch, signal)
    return await occupancy.waiter.promise
  }

  const acquireExternal = (signal?: AbortSignal): Promise<PhoneRuntimeHandle> => acquireOnCell(state.external, signal)

  const acquireIsolatedIos = (_signal?: AbortSignal): Promise<PhoneRuntimeHandle> => {
    try {
      assertOpen()
    } catch (error) {
      return Promise.reject(asError(error))
    }
    return Promise.reject(new PhoneDevicesError(
      'PHONE_UNAVAILABLE',
      'isolated iOS runtime acquire is unavailable until a private HOME/simulator-set/listen-bind provider exists',
    ))
  }

  const abortEpoch = (cell: Cell): void => {
    for (const occupancy of [...cell.occupancies.values()]) {
      if (occupancy.state === 'released' || occupancy.state === 'aborted') continue
      const pending = occupancy.state === 'pending'
      occupancy.state = 'aborted'
      if (pending) {
        occupancy.waiter.reject(new PhoneDevicesError('PHONE_ABORTED', 'the phone runtime occupancy was aborted'))
        void occupancy.waiter.promise.catch(() => {})
        cell.occupancies.delete(occupancy.id)
      }
    }
  }

  const replaceExternal = async (request: {
    executablePath: string
    environment?: Readonly<Record<string, string>>
    signal?: AbortSignal
  }): Promise<void> => {
    assertOpen()
    if (request.signal?.aborted === true) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime replace was cancelled')
    }
    const cell = state.external
    abortEpoch(cell)
    const previousStop = cell.stop
    const previousEpoch = cell.epoch
    cell.phase = 'replacing'
    cell.startAbort.abort()
    if (previousStop !== undefined) await previousStop(request.signal)
    if (cell.epoch !== previousEpoch) return
    cell.generation = undefined
    cell.stop = undefined
    cell.config = slotConfig('host-external', request.executablePath, request.environment)
    cell.epoch += 1
    cell.startAbort = new AbortController()
    const replaceSignal = request.signal
    if (replaceSignal !== undefined) {
      const onAbort = (): void => {
        cell.startAbort.abort()
      }
      replaceSignal.addEventListener('abort', onAbort, { once: true })
      beginStart(cell, true)
      try {
        await cell.startWork
      } finally {
        replaceSignal.removeEventListener('abort', onAbort)
      }
    } else {
      beginStart(cell, true)
      await cell.startWork
    }
    if (cell.startError !== undefined) {
      const error = cell.startError
      if (error instanceof PhoneDevicesError) throw error
      throw new PhoneDevicesError(
        'PHONE_UNAVAILABLE',
        asError(error).message,
        { cause: asError(error) },
      )
    }
  }

  const stopExternal = async (signal?: AbortSignal): Promise<void> => {
    assertOpen()
    if (signal?.aborted === true) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime stop was cancelled')
    }
    const cell = state.external
    const stop = cell.stop
    cell.startAbort.abort()
    cell.generation = undefined
    cell.unresolved = true
    cell.phase = 'empty'
    if (stop !== undefined) await stop(signal)
  }

  const dispose = (): Promise<void> => {
    if (state.disposeWork !== undefined) return state.disposeWork
    const completion = Promise.withResolvers<void>()
    state.disposeWork = completion.promise
    completion.resolve((async () => {
      state.phase = 'closing'
      const cell = state.external
      try {
        for (const occupancy of cell.occupancies.values()) {
          if (occupancy.state === 'pending') {
            occupancy.state = 'aborted'
            occupancy.waiter.reject(new PhoneDevicesError('PHONE_DISPOSED', 'the phone runtime pool is closed'))
            void occupancy.waiter.promise.catch(() => {})
          } else if (occupancy.state === 'live') {
            occupancy.state = 'aborted'
          }
        }
        await cleanupCell(cell)
      } finally {
        finishDisposePhase()
      }
    })())
    return state.disposeWork
  }

  const settleCellCleanup = (cell: Cell): void => {
    state.cleanupPending = Math.max(0, state.cleanupPending - 1)
    cell.phase = 'empty'
    cell.generation = undefined
    cell.stop = undefined
    finishDisposePhase()
  }

  const finishDisposePhase = (): void => {
    if (state.phase === 'closing') state.phase = 'closed'
  }

  return {
    acquireExternal,
    acquireIsolatedIos,
    replaceExternal,
    stopExternal,
    dispose,
    lifecycle,
  }
}

function slotConfig(
  provenance: PhoneRuntimeSlotConfig['provenance'],
  executablePath: string | undefined,
  environment: Readonly<Record<string, string>> | undefined,
): PhoneRuntimeSlotConfig {
  return {
    provenance,
    ...(executablePath !== undefined ? { executablePath } : {}),
    ...(environment !== undefined ? { environment } : {}),
  }
}

function newCell(slot: PhoneRuntimeSlot, kind: PhoneRuntimeKind, config: PhoneRuntimeSlotConfig): Cell {
  return {
    slot,
    kind,
    epoch: 0,
    phase: 'empty',
    unresolved: false,
    config,
    occupancies: new Map(),
    generation: undefined,
    stop: undefined,
    startAbort: new AbortController(),
    startWork: undefined,
    startError: undefined,
    cleanupWork: undefined,
    starts: new Set(),
    stops: new Set(),
  }
}

function liveOrPending(cell: Cell): number {
  let count = 0
  for (const occupancy of cell.occupancies.values()) {
    if (occupancy.state === 'live' || occupancy.state === 'pending') count += 1
  }
  return count
}

function memoizeStop(started: PhoneRuntimeStart): (signal?: AbortSignal) => Promise<void> {
  let work: Promise<void> | undefined
  return (signal) => {
    if (work !== undefined) return work
    const completion = Promise.withResolvers<void>()
    work = completion.promise
    try {
      completion.resolve(started.stop(signal))
    } catch (error) {
      completion.reject(error)
    }
    return work
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('phone runtime cleanup failed')
}
