import type { Branded } from '@deepseek-ai/dsh-brand'

/** Desktop-minted identifier for one accepted Host generation. */
export type HostGenerationId = Branded<'HostGenerationId'>
/** Bounded wire correlation identifier supplied by Host. */
export type HostRequestId = Branded<'HostRequestId'>
/** Broker-minted identifier for one Desktop-owned lease. */
export type HostLeaseId = Branded<'HostLeaseId'>
/** Unforgeable Desktop-minted authority paired with one generation. */
export type HostGenerationCapability = Branded<'HostGenerationCapability'>

/** Desktop-minted authority for one accepted Host hello. */
export interface HostGenerationIdentityFactory {
  /** @returns Fresh generation and capability authority. */
  mint(): { readonly generation: HostGenerationId; readonly capability: HostGenerationCapability }
}

/** Exact channel object that owns one Host generation. */
export interface HostGenerationChannel {
  /** @param message Correlated Desktop response whose delivery failure is contained. */
  emit(message: DesktopProtocolMessage): void
}

/** Versioned Desktop response emitted with bounded correlation values. */
export type DesktopProtocolMessage =
  | { readonly version: 1; readonly type: 'desktop-initialized'; readonly request: HostRequestId; readonly generation: HostGenerationId; readonly capability: HostGenerationCapability }
  | { readonly version: 1; readonly type: 'desktop-unsupported'; readonly request: HostRequestId; readonly reason: 'PLATFORM_CONTAINMENT_UNAVAILABLE' }
  | { readonly version: 1; readonly type: 'spawned'; readonly request: HostRequestId; readonly lease: HostLeaseId }
  | { readonly version: 1; readonly type: 'spawn-rejected'; readonly request: HostRequestId; readonly reason: ProtocolRejection }
  | { readonly version: 1; readonly type: 'stopped'; readonly request: HostRequestId; readonly lease: HostLeaseId; readonly report: BrokerCleanupReport }

/** Typed protocol rejection with bounded diagnostic detail. */
export interface ProtocolRejection {
  readonly code: 'START_FAILED' | 'DUPLICATE_LEASE'
  readonly message: string
}

/** Phase-coupled terminal cleanup issue reported by a lease. */
export type BrokerCleanupIssue =
  | { readonly phase: 'graceful'; readonly code: 'graceful-failed'; readonly message: string }
  | { readonly phase: 'settle'; readonly code: 'settle-failed'; readonly message: string }
  | { readonly phase: 'force'; readonly code: 'force-failed'; readonly message: string }
  | { readonly phase: 'final'; readonly code: 'final-failed' | 'fixture-not-quiescent'; readonly message: string }

/** Verified lease quiescence and ordered cleanup issues. */
export interface BrokerCleanupReport {
  readonly quiescent: boolean
  readonly issues: readonly BrokerCleanupIssue[]
}

/** Desktop-owned lease whose cleanup is memoized by the generation. */
export interface BrokerLease {
  readonly id: HostLeaseId
  readonly exited: Promise<void>
  /** @returns Memoizable terminal cleanup report. */
  stop(): Promise<BrokerCleanupReport>
}

/** Reservation that starts once or cancels after the generation closes. */
export interface BrokerReservation {
  /** Exact Desktop-reserved lease identity published synchronously from `reserve()` before startup. */
  readonly id: HostLeaseId
  /**
   * @returns Lease startup that must preserve the reserved identity.
   * A mismatched identity fails closed and is cleaned without generation ownership.
   */
  start(): Promise<BrokerLease>
  /** Cancels before startup. @returns Optional cancellation settlement. */
  cancel(): void | Promise<void>
}

/** Reserves broker ownership before asynchronous startup begins. */
export interface HostGenerationBroker {
  /**
   * @param request Correlation identifier reserved before startup.
   * @returns Exclusive reservation whose `id` is published before startup.
   */
  reserve(request: HostRequestId): BrokerReservation
}

/** Bounded asynchronous lane identity used for expiry and late diagnostics. */
export type HostGenerationLane =
  | { readonly kind: 'host' }
  | { readonly kind: 'reservation'; readonly request: HostRequestId }
  | { readonly kind: 'collision'; readonly request: HostRequestId; readonly lease: HostLeaseId }
  | { readonly kind: 'lease'; readonly lease: HostLeaseId }

/** Bounds every foreign asynchronous lane and reports expiry without abandoning observation. */
export interface HostGenerationDeadline {
  /** @param lane Stable lane identity. @param operation Owned settlement. @returns Settled value or expiry. */
  settle<T>(lane: HostGenerationLane, operation: Promise<T>): Promise<{ readonly status: 'settled'; readonly value: T } | { readonly status: 'expired' }>
}

/** Contains callback failures and observes abandoned-lane rejections exactly once. */
export interface HostGenerationDiagnostics {
  /** @param error Contained callback failure. */
  callbackFailed(error: unknown): void
  /** @param lane Abandoned lane. @param error Distinct rejection after abandonment. */
  lateFailure(lane: HostGenerationLane, error: unknown): void
  /** @param lane Detached cleanup lane. @param issue Terminal cleanup issue. */
  lateCleanupIssue(lane: HostGenerationLane, issue: BrokerCleanupIssue): void
  /** @param lease Lease whose independent exit observation rejected. @param error Exit observation failure. */
  leaseExitFailed(lease: HostLeaseId, error: unknown): void
}

/** Host cleanup participant invoked after generation closure is published. */
export interface HostGenerationHost {
  /** @returns Prompt-return Host cleanup settlement. */
  stop(): void | Promise<void>
}

/** Channel-bound generation state with memoized closure and bounded ownership counts. */
export interface InitializedHostGeneration {
  /**
   * @param message Strict wire request.
   * @returns Correlated handling settlement. Dispatch is deferred through `Promise.resolve().then`,
   * so parse failures reject asynchronously and there is no global start barrier.
   */
  request(message: unknown): Promise<void>
  /** @returns Exact memoized closure; rejects with `HostGenerationCloseError` when closure reports issues. */
  disconnect(): Promise<HostGenerationCloseReport>
  /** @returns The same exact Promise; rejects with `HostGenerationCloseError` when closure reports issues. */
  hostExited(): Promise<HostGenerationCloseReport>
  /** @returns The same exact Promise; rejects with `HostGenerationCloseError` when closure reports issues. */
  cleanup(): Promise<HostGenerationCloseReport>
  /**
   * @returns Current retained reservation, lease, collision, and per-lease-id admission-tail counts.
   * Close snapshots and clears these collections before foreign cleanup; a claimed reservation must not restore admission tails.
   */
  ownershipSnapshot(): {
    readonly reservations: number
    readonly leases: number
    readonly collisions: number
    readonly admissionTails: number
  }
}

/** Structurally ordered Host, reservation, or lease closure failure. */
export type HostGenerationCloseIssue =
  | { readonly kind: 'host'; readonly phase: 'host'; readonly code: 'host-stop-failed' | 'host-stop-expired'; readonly message: string }
  | { readonly kind: 'reservation'; readonly phase: 'reservation'; readonly request: HostRequestId; readonly code: 'reservation-start-failed' | 'reservation-start-expired'; readonly message: string }
  | { readonly kind: 'collision'; readonly phase: 'collision'; readonly request: HostRequestId; readonly lease: HostLeaseId; readonly code: 'duplicate-lease'; readonly message: string }
  | { readonly kind: 'lease'; readonly lease: HostLeaseId; readonly issue: BrokerCleanupIssue }

/** Terminal generation quiescence and stable ordered issues. */
export interface HostGenerationCloseReport {
  readonly quiescent: boolean
  readonly issues: readonly HostGenerationCloseIssue[]
}

/** Aggregate rejection retaining the typed terminal closure report. */
export class HostGenerationCloseError extends AggregateError {
  readonly report: HostGenerationCloseReport

  /** @param report Typed terminal closure report. */
  constructor(report: HostGenerationCloseReport) {
    super(report.issues.map(issue => new Error(issueMessage(issue))), 'Host generation did not close cleanly')
    this.name = 'HostGenerationCloseError'
    this.report = report
  }
}

/** Accepts one correlated Host hello per exact channel and mints Desktop authority. */
export interface HostGenerationOwner {
  /**
   * @param channel Exact owner channel.
   * @param message Strict correlated hello.
   * @param host Optional cleanup participant.
   * @returns Initialized generation or correlated unsupported response.
   */
  hello(channel: HostGenerationChannel, message: unknown, host?: HostGenerationHost): InitializedHostGeneration | DesktopProtocolMessage
}

const MAX_WIRE_VALUE_LENGTH = 128

/** Fail-closed generation memory limits selected by the caller. */
export interface HostGenerationResourcePolicy {
  readonly maxRememberedRequests: number
}

/**
 * Creates the private Desktop test-policy owner for Host-generation broker leases.
 *
 * This owner launches no process and does not establish production ownership or containment.
 *
 * @param support Abstract containment availability decision supplied by the platform Adapter.
 * @param identities Desktop authority factory invoked only for accepted generations.
 * @param broker Reservation Adapter whose `id` is published before startup.
 * @param deadline Adapter that bounds every asynchronous ownership lane.
 * @param resourcePolicy Validated capacity that fails closed before replay history is lost.
 * @param diagnostics Contained callback and abandoned-lane diagnostic sink.
 * @returns An owner that accepts one hello per exact channel object.
 */
export function createHostGenerationOwner(
  support: 'available' | 'unavailable',
  identities: HostGenerationIdentityFactory,
  broker: HostGenerationBroker,
  deadline: HostGenerationDeadline,
  resourcePolicy: HostGenerationResourcePolicy,
  diagnostics: HostGenerationDiagnostics = {
    callbackFailed() {}, lateFailure() {}, lateCleanupIssue() {}, leaseExitFailed() {},
  },
): HostGenerationOwner {
  if (!Number.isSafeInteger(resourcePolicy.maxRememberedRequests) || resourcePolicy.maxRememberedRequests <= 0) {
    throw new Error('maxRememberedRequests must be a positive safe integer')
  }
  const channels = new WeakMap<HostGenerationChannel, true>()
  return {
    hello(channel, message, host) {
      if (channels.has(channel)) throw new Error('Host channel already initialized')
      const hello = parseHello(message)
      channels.set(channel, true)
      if (support === 'unavailable') {
        const unsupported: DesktopProtocolMessage = {
          version: 1,
          type: 'desktop-unsupported',
          request: hello.request,
          reason: 'PLATFORM_CONTAINMENT_UNAVAILABLE',
        }
        emitContained(channel, unsupported, diagnostics)
        return unsupported
      }
      const identity = identities.mint()
      const state = createGeneration(channel, identity, broker, deadline, resourcePolicy, diagnostics, host)
      emitContained(channel, {
        version: 1,
        type: 'desktop-initialized',
        request: hello.request,
        generation: identity.generation,
        capability: identity.capability,
      }, diagnostics)
      return state
    },
  }
}

interface GenerationIdentity {
  readonly generation: HostGenerationId
  readonly capability: HostGenerationCapability
}

type ReservationOutcome =
  | { readonly kind: 'started'; readonly lease: OwnedLease }
  | { readonly kind: 'cancelled' }

interface ReservationRecord {
  readonly request: HostRequestId
  readonly outcome: Deferred<ReservationOutcome>
  readonly cancellation: Deferred<undefined>
  predecessor: Promise<void>
  releaseAdmission: () => void
  reservation?: BrokerReservation
  reservedId?: HostLeaseId
  cancellationRequired: boolean
  cancellationStarted: boolean
  startInvoked: boolean
  outcomeSettled: boolean
  lateOutcomeOwned: boolean
  claimedByClose: boolean
}

type ReservationSettlement =
  | { readonly kind: 'expired'; readonly issue: HostGenerationCloseIssue }
  | { readonly kind: 'failed'; readonly issue: HostGenerationCloseIssue }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'started'; readonly request: HostRequestId; readonly lease: OwnedLease }

interface ReservationCloseResult {
  readonly reservations: readonly HostGenerationCloseIssue[]
  readonly collisions: readonly HostGenerationCloseIssue[]
  readonly leases: Promise<HostGenerationCloseIssue[]>
}

interface OwnedLease {
  readonly id: HostLeaseId
  readonly exited: Promise<void>
  /** @returns Memoizable terminal cleanup report. */
  stop(): Promise<BrokerCleanupReport>
  /** @returns Memoized bounded cleanup settlement for the owned lease lane. */
  settle(): Promise<{ readonly status: 'settled'; readonly value: BrokerCleanupReport } | { readonly status: 'expired' }>
  retired: boolean
}

function createGeneration(
  channel: HostGenerationChannel,
  identity: GenerationIdentity,
  broker: HostGenerationBroker,
  deadline: HostGenerationDeadline,
  resourcePolicy: HostGenerationResourcePolicy,
  diagnostics: HostGenerationDiagnostics,
  host: HostGenerationHost | undefined,
): InitializedHostGeneration {
  const reservations = new Map<HostRequestId, ReservationRecord>()
  const replayRefusals = new Set<HostRequestId>()
  const leases = new Map<HostLeaseId, OwnedLease>()
  const collisionLanes: Array<{
    readonly issue: HostGenerationCloseIssue
    readonly cleanup: Promise<HostGenerationCloseIssue[]>
  }> = []
  let closing = false
  let closePromise: Promise<HostGenerationCloseReport> | undefined
  const admissionTails = new Map<HostLeaseId, Promise<void>>()

  const rememberRequest = (request: HostRequestId): void => {
    if (replayRefusals.has(request)) throw new Error('duplicate Host request')
    if (replayRefusals.size >= resourcePolicy.maxRememberedRequests) {
      const closingResult = close()
      void closingResult.catch((error: unknown) => {
        containDiagnosticFailure(diagnostics, error)
      })
      throw new Error('Host request memory capacity reached; generation is closing')
    }
    replayRefusals.add(request)
  }

  const adoptLease = (request: HostRequestId, owned: OwnedLease):
    | { readonly kind: 'adopted'; readonly lease: OwnedLease }
    | { readonly kind: 'duplicate'; readonly lease: OwnedLease } => {
    if (closing) {
      startDetachedLeaseCleanup(owned, deadline, diagnostics)
      return { kind: 'adopted', lease: owned }
    }
    const existing = leases.get(owned.id)
    if (existing !== undefined) {
      const cleanup = createDeferred<HostGenerationCloseIssue[]>()
      collisionLanes.push({
        issue: {
          kind: 'collision',
          phase: 'collision',
          request,
          lease: owned.id,
          code: 'duplicate-lease',
          message: `duplicate lease ${owned.id}`,
        },
        cleanup: cleanup.promise,
      })
      void settleCollision(owned, request, deadline, diagnostics).then(
        (issues) => { cleanup.resolve(issues) },
        (error: unknown) => { cleanup.reject(error) },
      )
      return { kind: 'duplicate', lease: owned }
    }
    leases.set(owned.id, owned)
    return { kind: 'adopted', lease: owned }
  }

  const close = (): Promise<HostGenerationCloseReport> => {
    if (closePromise !== undefined) return closePromise
    closing = true
    const deferred = createDeferred<HostGenerationCloseReport>()
    closePromise = deferred.promise
    void closeGeneration().then(
      (value) => { deferred.resolve(value) },
      (error: unknown) => { deferred.reject(error) },
    )
    return closePromise
  }

  const closeGeneration = async (): Promise<HostGenerationCloseReport> => {
    const reservationSnapshot = [...reservations.values()]
    reservationSnapshot.forEach((record) => {
      record.claimedByClose = true
      record.cancellationRequired = !record.outcomeSettled
    })
    const leaseSnapshot = [...leases.values()]
    const collisionSnapshot = [...collisionLanes]
    reservations.clear()
    leases.clear()
    collisionLanes.length = 0
    replayRefusals.clear()
    admissionTails.clear()
    const hostLane = startHostLane(host, deadline, diagnostics)
    const collisionCleanupLanes = collisionSnapshot.map(collision => collision.cleanup)
    const leaseLanes = leaseSnapshot.map(lease => settleLease(lease, deadline, diagnostics))
    reservationSnapshot.forEach((record) => {
      if (!record.outcomeSettled) startReservationCancellation(record, diagnostics)
    })
    const reservationLanes = reservationSnapshot.map(record => settleReservationOutcome(
      record, deadline, diagnostics,
    ))
    const reservationSettlements = await Promise.all(reservationLanes)
    const closingLeaseIds = new Set(leaseSnapshot.map(lease => lease.id))
    const reservationResults = reservationSettlements.map((settlement) => {
      switch (settlement.kind) {
        case 'expired': return reservationCloseResult(settlement.issue)
        case 'failed': return reservationCloseResult(settlement.issue)
        case 'cancelled': return reservationCloseResult()
        case 'started': {
          const duplicate = closingLeaseIds.has(settlement.lease.id)
          closingLeaseIds.add(settlement.lease.id)
          const cleanup = duplicate
            ? settleCollision(settlement.lease, settlement.request, deadline, diagnostics)
            : settleLease(settlement.lease, deadline, diagnostics)
          return {
            reservations: [],
            collisions: duplicate ? [{
              kind: 'collision' as const,
              phase: 'collision' as const,
              request: settlement.request,
              lease: settlement.lease.id,
              code: 'duplicate-lease' as const,
              message: `duplicate lease ${settlement.lease.id}`,
            }] : [],
            leases: cleanup,
          }
        }
        default: return assertNever(settlement)
      }
    })
    const [hostResult, reservationCleanupResults, collisionResults, leaseResults] = await Promise.all([
      hostLane,
      Promise.all(reservationResults.map(result => Promise.resolve(result.leases))),
      Promise.all(collisionCleanupLanes),
      Promise.all(leaseLanes),
    ])
    const issues: HostGenerationCloseIssue[] = []
    if (hostResult !== undefined) issues.push(hostResult)
    reservationResults.forEach((result) => { issues.push(...result.reservations) })
    reservationResults.forEach((result) => { issues.push(...result.collisions) })
    collisionSnapshot.forEach((collision) => { issues.push(collision.issue) })
    reservationCleanupResults.forEach((result) => { issues.push(...result) })
    collisionResults.forEach((result) => { issues.push(...result) })
    leaseResults.forEach((result) => { issues.push(...result) })
    const report = Object.freeze({ quiescent: issues.length === 0, issues: Object.freeze(issues) })
    if (!report.quiescent) throw new HostGenerationCloseError(report)
    return report
  }

  const generation: InitializedHostGeneration = {
    request(message) {
      return Promise.resolve().then(() => {
        const record = strictRecord(message)
        if (record.type === 'spawn-request') return spawnRequest(parseSpawn(record))
        if (record.type === 'stop-request') return stopRequest(parseStop(record))
        throw new Error('unknown Host generation request type')
      })
    },
    disconnect: close,
    hostExited: close,
    cleanup: close,
    ownershipSnapshot: () => ({
      reservations: reservations.size,
      leases: leases.size,
      collisions: collisionLanes.length,
      admissionTails: admissionTails.size,
    }),
  }

  function spawnRequest(request: ParsedSpawn): Promise<void> {
    requireAuthority(request, identity)
    if (closing) return Promise.reject(new Error('Host generation is closing'))
    if (reservations.has(request.request)) return Promise.reject(new Error('duplicate Host request'))
    rememberRequest(request.request)
    const admission = createDeferred<undefined>()
    const record: ReservationRecord = {
      request: request.request,
      outcome: createDeferred<ReservationOutcome>(),
      cancellation: createDeferred<undefined>(),
      predecessor: Promise.resolve(),
      releaseAdmission: () => { admission.resolve(undefined) },
      cancellationRequired: false,
      cancellationStarted: false,
      startInvoked: false,
      outcomeSettled: false,
      lateOutcomeOwned: false,
      claimedByClose: false,
    }
    reservations.set(request.request, record)
    let reservation: BrokerReservation
    try {
      reservation = broker.reserve(request.request)
      record.reservation = reservation
      record.reservedId = reservation.id
      // Close already snapshotted and cleared tails; claimed reservations must not restore them.
      if (!record.claimedByClose && !closing) {
        record.predecessor = admissionTails.get(reservation.id) ?? Promise.resolve()
        admissionTails.set(reservation.id, admission.promise)
        void admission.promise.then(() => {
          if (admissionTails.get(reservation.id) === admission.promise) admissionTails.delete(reservation.id)
        })
      }
      if (record.claimedByClose) startReservationCancellation(record, diagnostics)
    } catch (error) {
      if (record.cancellationRequired && !record.cancellationStarted) record.cancellation.resolve(undefined)
      record.outcomeSettled = true
      record.outcome.reject(error)
      return finishSpawn(record, request)
    }
    if (closing) {
      startReservationCancellation(record, diagnostics)
      return finishSpawn(record, request)
    }
    try {
      record.startInvoked = true
      const started = reservation.start()
      void started.then(
        (lease) => {
          const owned = observeOwnedLease(lease, deadline, diagnostics)
          if (record.reservedId !== owned.id) {
            record.lateOutcomeOwned = true
            record.outcomeSettled = true
            record.outcome.reject(new Error(`started lease ${owned.id} does not match reservation ${record.reservedId}`))
            startDetachedLeaseCleanup(owned, deadline, diagnostics)
            return
          }
          if (record.lateOutcomeOwned) {
            record.outcomeSettled = true
            record.outcome.resolve({ kind: 'cancelled' })
            startDetachedLeaseCleanup(owned, deadline, diagnostics)
            return
          }
          record.outcomeSettled = true
          record.outcome.resolve({ kind: 'started', lease: owned })
        },
        (error: unknown) => {
          if (record.lateOutcomeOwned) {
            reportLateReservationFailure(record, diagnostics, error)
            return
          }
          record.outcomeSettled = true
          record.outcome.reject(error)
        },
      )
    } catch (error) {
      record.outcomeSettled = true
      record.outcome.reject(error)
    }
    return finishSpawn(record, request)
  }

  async function finishSpawn(record: ReservationRecord, request: ParsedSpawn): Promise<void> {
    try {
      const outcome = await record.outcome.promise
      await record.predecessor
      reservations.delete(request.request)
      if (record.claimedByClose) {
        record.releaseAdmission()
        return
      }
      switch (outcome.kind) {
        case 'cancelled':
          record.releaseAdmission()
          return
        case 'started': break
        default: return assertNever(outcome)
      }
      const adoption = adoptLease(request.request, outcome.lease)
      switch (adoption.kind) {
        case 'duplicate':
          if (!closing) emitContained(channel, {
            version: 1,
            type: 'spawn-rejected',
            request: request.request,
            reason: { code: 'DUPLICATE_LEASE', message: `duplicate lease ${adoption.lease.id}` },
          }, diagnostics)
          record.releaseAdmission()
          return
        case 'adopted':
          if (closing) {
            record.releaseAdmission()
            return
          }
          emitContained(channel, {
            version: 1,
            type: 'spawned',
            request: request.request,
            lease: adoption.lease.id,
          }, diagnostics)
          record.releaseAdmission()
          return
        default: return assertNever(adoption)
      }
    } catch (error: unknown) {
      await record.predecessor
      reservations.delete(request.request)
      record.releaseAdmission()
      if (!closing) emitContained(channel, {
        version: 1,
        type: 'spawn-rejected',
        request: request.request,
        reason: { code: 'START_FAILED', message: boundedMessage(error) },
      }, diagnostics)
    }
  }

  async function stopRequest(request: ParsedStop): Promise<void> {
    requireAuthority(request, identity)
    if (closing) throw new Error('Host generation is closing')
    if (replayRefusals.has(request.request)) throw new Error('duplicate Host request')
    rememberRequest(request.request)
    const lease = leases.get(request.lease)
    if (lease === undefined) throw new Error('lease does not belong to this generation')
    const settlement = await lease.settle()
    switch (settlement.status) {
      case 'expired': throw new Error(`lease cleanup expired: ${lease.id}`)
      case 'settled': break
      default: return assertNever(settlement)
    }
    if (closing) return
    if (!lease.retired) {
      if (leases.get(lease.id) !== lease) return
      leases.delete(lease.id)
      lease.retired = true
    }
    const report = normalizeBrokerReport(settlement.value)
    emitContained(channel, {
      version: 1,
      type: 'stopped',
      request: request.request,
      lease: request.lease,
      report,
    }, diagnostics)
  }

  return generation
}

interface ParsedHello { readonly request: HostRequestId }
interface ParsedSpawn extends GenerationIdentity { readonly request: HostRequestId }
interface ParsedStop extends GenerationIdentity { readonly request: HostRequestId; readonly lease: HostLeaseId }

function parseHello(value: unknown): ParsedHello {
  const record = strictRecord(value)
  requireKeys(record, ['version', 'type', 'request'])
  if (record.version !== 1 || record.type !== 'host-hello') throw new Error('invalid Host hello discriminant or version')
  return { request: wireValue(record.request, 'request') as HostRequestId }
}

function parseSpawn(record: Record<string, unknown>): ParsedSpawn {
  requireKeys(record, ['version', 'type', 'request', 'generation', 'capability'])
  if (record.version !== 1 || record.type !== 'spawn-request') throw new Error('invalid spawn request discriminant or version')
  return {
    request: wireValue(record.request, 'request') as HostRequestId,
    generation: wireValue(record.generation, 'generation') as HostGenerationId,
    capability: wireValue(record.capability, 'capability') as HostGenerationCapability,
  }
}

function parseStop(record: Record<string, unknown>): ParsedStop {
  requireKeys(record, ['version', 'type', 'request', 'generation', 'capability', 'lease'])
  if (record.version !== 1 || record.type !== 'stop-request') throw new Error('invalid stop request discriminant or version')
  return {
    request: wireValue(record.request, 'request') as HostRequestId,
    generation: wireValue(record.generation, 'generation') as HostGenerationId,
    capability: wireValue(record.capability, 'capability') as HostGenerationCapability,
    lease: wireValue(record.lease, 'lease') as HostLeaseId,
  }
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('protocol message must be an object')
  return value as Record<string, unknown>
}

function requireKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('protocol message contains unknown or missing fields')
  }
}

function wireValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WIRE_VALUE_LENGTH) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function requireAuthority(request: GenerationIdentity, identity: GenerationIdentity): void {
  if (request.generation !== identity.generation || request.capability !== identity.capability) {
    throw new Error('request does not belong to this generation')
  }
}

function observeOwnedLease(
  lease: BrokerLease,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): OwnedLease {
  const owned = memoizedLease(lease, deadline, diagnostics)
  void owned.exited.catch((error: unknown) => {
    try {
      diagnostics.leaseExitFailed(owned.id, error)
    } catch (diagnosticError) {
      containDiagnosticFailure(diagnostics, diagnosticError)
    }
  })
  return owned
}

function memoizedLease(
  lease: BrokerLease,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): OwnedLease {
  let stopped: Promise<BrokerCleanupReport> | undefined
  let settlement: Promise<{ readonly status: 'settled'; readonly value: BrokerCleanupReport } | { readonly status: 'expired' }> | undefined
  const owned: OwnedLease = {
    id: lease.id,
    exited: lease.exited,
    retired: false,
    stop() {
      if (stopped !== undefined) return stopped
      const deferred = createDeferred<BrokerCleanupReport>()
      stopped = deferred.promise
      try {
        void Promise.resolve(lease.stop()).then(
          (report) => { deferred.resolve(report) },
          (error: unknown) => { deferred.reject(error) },
        )
      } catch (error) {
        deferred.reject(error)
      }
      return stopped
    },
    settle() {
      if (settlement !== undefined) return settlement
      const deferred = createDeferred<{ readonly status: 'settled'; readonly value: BrokerCleanupReport } | { readonly status: 'expired' }>()
      settlement = deferred.promise
      void settleBounded(
        deadline, { kind: 'lease', lease: owned.id }, owned.stop(), diagnostics,
      ).then(
        (result) => { deferred.resolve(result) },
        (error: unknown) => { deferred.reject(error) },
      )
      return settlement
    },
  }
  return owned
}

async function startHostLane(
  host: HostGenerationHost | undefined,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): Promise<HostGenerationCloseIssue | undefined> {
  if (host === undefined) return undefined
  let operation: Promise<void>
  try {
    operation = Promise.resolve(host.stop())
  } catch (error) {
    return { kind: 'host', phase: 'host', code: 'host-stop-failed', message: errorMessage(error) }
  }
  try {
    const result = await settleBounded(deadline, { kind: 'host' }, operation, diagnostics)
    switch (result.status) {
      case 'settled': return undefined
      case 'expired': return { kind: 'host', phase: 'host', code: 'host-stop-expired', message: 'Host stop expired' }
      default: return assertNever(result)
    }
  } catch (error) {
    return { kind: 'host', phase: 'host', code: 'host-stop-failed', message: errorMessage(error) }
  }
}

function startReservationCancellation(record: ReservationRecord, _diagnostics: HostGenerationDiagnostics): void {
  if (record.cancellationStarted) return
  const reservation = record.reservation
  if (reservation === undefined) return
  record.cancellationStarted = true
  try {
    void Promise.resolve(reservation.cancel()).then(
      () => {
        if (!record.startInvoked) {
          record.lateOutcomeOwned = true
          record.outcomeSettled = true
          record.outcome.resolve({ kind: 'cancelled' })
        }
        record.cancellation.resolve(undefined)
      },
      (error: unknown) => { retireReservationAfterCancellationFailure(record, error) },
    )
  } catch (error) {
    retireReservationAfterCancellationFailure(record, error)
  }
  void record.cancellation.promise.catch(() => {
    // The reservation settlement lane owns this rejection; this branch only prevents an unhandled sibling.
  })
}

function reportLateReservationFailure(
  record: ReservationRecord,
  diagnostics: HostGenerationDiagnostics,
  error: unknown,
): void {
  try {
    diagnostics.lateFailure({ kind: 'reservation', request: record.request }, error)
  } catch (diagnosticError) {
    containDiagnosticFailure(diagnostics, diagnosticError)
  }
}

function retireReservationAfterCancellationFailure(record: ReservationRecord, error: unknown): void {
  retireReservationOutcome(record)
  record.cancellation.reject(error)
}

function retireReservationOutcome(record: ReservationRecord): void {
  record.lateOutcomeOwned = true
  if (record.outcomeSettled) return
  record.outcomeSettled = true
  record.outcome.resolve({ kind: 'cancelled' })
}

async function settleReservationOutcome(
  record: ReservationRecord,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): Promise<ReservationSettlement> {
  const lane: HostGenerationLane = { kind: 'reservation', request: record.request }
  const cancellationAndOutcome = record.cancellationRequired
    ? record.cancellation.promise.then(() => record.outcome.promise)
    : record.outcome.promise
  try {
    const result = await settleBounded(deadline, lane, cancellationAndOutcome, diagnostics)
    switch (result.status) {
      case 'expired':
        retireReservationOutcome(record)
        record.releaseAdmission()
        void record.outcome.promise.then(
          (outcome) => {
            switch (outcome.kind) {
              case 'cancelled': return
              case 'started':
                startDetachedLeaseCleanup(outcome.lease, deadline, diagnostics)
                return
              default: return assertNever(outcome)
            }
          },
          () => {},
        )
        return {
          kind: 'expired',
          issue: {
            kind: 'reservation', phase: 'reservation', request: record.request,
            code: 'reservation-start-expired', message: 'reservation start expired',
          },
        }
      case 'settled': break
      default: return assertNever(result)
    }
    switch (result.value.kind) {
      case 'cancelled':
        record.releaseAdmission()
        return { kind: 'cancelled' }
      case 'started': return {
        kind: 'started', request: record.request, lease: result.value.lease,
      }
      default: return assertNever(result.value)
    }
  } catch (error) {
    retireReservationOutcome(record)
    record.releaseAdmission()
    void record.outcome.promise.then(
      (outcome) => {
        switch (outcome.kind) {
          case 'cancelled': return
          case 'started':
            startDetachedLeaseCleanup(outcome.lease, deadline, diagnostics)
            return
          default: return assertNever(outcome)
        }
      },
      () => {},
    )
    return {
      kind: 'failed',
      issue: {
        kind: 'reservation', phase: 'reservation', request: record.request,
        code: 'reservation-start-failed', message: errorMessage(error),
      },
    }
  }
}

function reservationCloseResult(reservation?: HostGenerationCloseIssue): ReservationCloseResult {
  if (reservation === undefined) return { reservations: [], collisions: [], leases: Promise.resolve([]) }
  return { reservations: [reservation], collisions: [], leases: Promise.resolve([]) }
}

async function settleCollision(
  lease: OwnedLease,
  request: HostRequestId,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): Promise<HostGenerationCloseIssue[]> {
  const lane: HostGenerationLane = { kind: 'collision', request, lease: lease.id }
  return settleLeaseOnLane(lease, lane, deadline, diagnostics)
}

async function settleLease(
  lease: OwnedLease,
  _deadline: HostGenerationDeadline,
  _diagnostics: HostGenerationDiagnostics,
): Promise<HostGenerationCloseIssue[]> {
  try {
    const result = await lease.settle()
    switch (result.status) {
      case 'expired': return [leaseCleanupIssue(lease.id, {
        phase: 'final', code: 'final-failed', message: 'lease cleanup expired',
      })]
      case 'settled': return normalizeBrokerReport(result.value).issues.map(issue => leaseCleanupIssue(lease.id, issue))
      default: return assertNever(result)
    }
  } catch (error) {
    return [leaseCleanupIssue(lease.id, { phase: 'final', code: 'final-failed', message: errorMessage(error) })]
  }
}

async function settleLeaseOnLane(
  lease: OwnedLease,
  lane: HostGenerationLane,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): Promise<HostGenerationCloseIssue[]> {
  let operation: Promise<BrokerCleanupReport>
  try {
    operation = lease.stop()
  } catch (error) {
    return [leaseCleanupIssue(lease.id, { phase: 'final', code: 'final-failed', message: errorMessage(error) })]
  }
  try {
    const result = await settleBounded(deadline, lane, operation, diagnostics)
    switch (result.status) {
      case 'expired': return [leaseCleanupIssue(lease.id, {
        phase: 'final', code: 'final-failed', message: 'lease cleanup expired',
      })]
      case 'settled': return normalizeBrokerReport(result.value).issues.map(issue => leaseCleanupIssue(lease.id, issue))
      default: return assertNever(result)
    }
  } catch (error) {
    return [leaseCleanupIssue(lease.id, { phase: 'final', code: 'final-failed', message: errorMessage(error) })]
  }
}

function leaseCleanupIssue(lease: HostLeaseId, issue: BrokerCleanupIssue): HostGenerationCloseIssue {
  return { kind: 'lease', lease, issue }
}

function normalizeBrokerReport(report: BrokerCleanupReport): BrokerCleanupReport {
  const issues = [...report.issues]
  if (!report.quiescent && !issues.some(issue => issue.code === 'fixture-not-quiescent')) issues.push({
    phase: 'final',
    code: 'fixture-not-quiescent',
    message: 'broker lease did not reach verified quiescence',
  })
  return {
    ...report,
    issues: issues.map((issue, index) => ({ issue, index }))
      .sort((left, right) => phaseOrder(left.issue.phase) - phaseOrder(right.issue.phase) || left.index - right.index)
      .map(({ issue }) => issue),
  }
}

function phaseOrder(phase: BrokerCleanupIssue['phase']): number {
  switch (phase) {
    case 'graceful': return 0
    case 'settle': return 1
    case 'force': return 2
    case 'final': return 3
    default: return assertNever(phase)
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected cleanup phase: ${String(value)}`)
}

async function settleBounded<T>(
  deadline: HostGenerationDeadline,
  lane: HostGenerationLane,
  operation: Promise<T>,
  diagnostics: HostGenerationDiagnostics,
): Promise<{ readonly status: 'settled'; readonly value: T } | { readonly status: 'expired' }> {
  let state: 'owned' | 'abandoned' | 'surfaced' = 'owned'
  let hasPendingRejection = false
  let pendingRejection: unknown
  void operation.catch((error: unknown) => {
    if (state === 'abandoned') observeLateFailure(diagnostics, lane, error)
    if (state === 'owned') {
      hasPendingRejection = true
      pendingRejection = error
    }
  })
  try {
    const result = await deadline.settle(lane, operation)
    switch (result.status) {
      case 'expired':
        state = 'abandoned'
        if (hasPendingRejection) observeLateFailure(diagnostics, lane, pendingRejection)
        return result
      case 'settled':
        state = 'surfaced'
        return result
      default:
        return assertNever(result)
    }
  } catch (error) {
    if (hasPendingRejection && Object.is(error, pendingRejection)) {
      state = 'surfaced'
      throw error
    }
    state = 'abandoned'
    if (hasPendingRejection) observeLateFailure(diagnostics, lane, pendingRejection)
    throw error
  }
}

function startDetachedLeaseCleanup(
  lease: OwnedLease,
  deadline: HostGenerationDeadline,
  diagnostics: HostGenerationDiagnostics,
): void {
  const lane: HostGenerationLane = { kind: 'lease', lease: lease.id }
  void settleLease(lease, deadline, diagnostics).then(
    (issues: HostGenerationCloseIssue[]) => {
      for (const result of issues) {
        switch (result.kind) {
          case 'lease': reportLateCleanupIssue(diagnostics, lane, result.issue); break
          case 'host':
          case 'reservation':
          case 'collision': throw new Error('detached lease cleanup returned a non-lease issue')
          default: assertNever(result)
        }
      }
    },
    (error: unknown) => { observeLateFailure(diagnostics, lane, error) },
  )
}

function containDiagnosticFailure(diagnostics: HostGenerationDiagnostics, error: unknown): void {
  try {
    diagnostics.callbackFailed(error)
  } catch {
    // Swallow only a secondary diagnostic callback failure after the original failure is retained.
  }
}

function reportLateCleanupIssue(
  diagnostics: HostGenerationDiagnostics,
  lane: HostGenerationLane,
  issue: BrokerCleanupIssue,
): void {
  try {
    diagnostics.lateCleanupIssue(lane, issue)
  } catch (diagnosticError) {
    containDiagnosticFailure(diagnostics, diagnosticError)
  }
}

function observeLateFailure(
  diagnostics: HostGenerationDiagnostics,
  lane: HostGenerationLane,
  error: unknown,
): void {
  try {
    diagnostics.lateFailure(lane, error)
  } catch (diagnosticError) {
    containDiagnosticFailure(diagnostics, diagnosticError)
  }
}

function emitContained(
  channel: HostGenerationChannel,
  message: DesktopProtocolMessage,
  diagnostics: HostGenerationDiagnostics,
): void {
  try {
    channel.emit(message)
  } catch (error) {
    containDiagnosticFailure(diagnostics, error)
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function issueMessage(issue: HostGenerationCloseIssue): string {
  switch (issue.kind) {
    case 'host': return issue.message
    case 'reservation': return issue.message
    case 'collision': return issue.message
    case 'lease': return issue.issue.message
    default: return assertNever(issue)
  }
}

function boundedMessage(error: unknown): string {
  return errorMessage(error).slice(0, MAX_WIRE_VALUE_LENGTH)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
