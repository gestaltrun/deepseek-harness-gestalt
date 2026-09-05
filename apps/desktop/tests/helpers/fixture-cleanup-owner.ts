/** Ordered cleanup phases reported by an owned fixture lease. */
export type FixtureCleanupPhase = 'graceful' | 'settle' | 'force' | 'final'

/** A typed cleanup failure whose code determines its reporting phase. */
export type FixtureCleanupIssue =
  | { readonly phase: 'graceful'; readonly code: 'graceful-failed'; readonly message: string }
  | { readonly phase: 'settle'; readonly code: 'settle-failed'; readonly message: string }
  | { readonly phase: 'force'; readonly code: 'force-failed'; readonly message: string }
  | { readonly phase: 'final'; readonly code: 'final-failed' | 'fixture-not-quiescent'; readonly message: string }

/** The lease's terminal verified-quiescence result and ordered issues. */
export interface FixtureCleanupReport {
  readonly quiescent: boolean
  readonly forced: boolean
  readonly issues: readonly FixtureCleanupIssue[]
}

/** Sole remaining cleanup ownership after the graceful-start barrier resolves. */
export interface FixtureCleanupContinuation {
  readonly settled: Promise<FixtureCleanupReport>
}

/** Owns fixture cleanup through the graceful-start barrier and terminal continuation. */
export interface OwnedFixtureLease {
  /**
   * Resolves after graceful cleanup was issued, transferring sole remaining ownership to
   * `continuation.settled`. Rejection means the lease retains and observes everything it started
   * and no owner-managed work remains. A fulfilled continuation is the sole remaining ownership
   * report; settled rejection is terminal and no lease-owned cleanup outlives that rejection.
   */
  beginCleanup(): Promise<FixtureCleanupContinuation>
}

/** Participates in cleanup after the fixture's graceful-start barrier settles. */
export interface HostCleanupParticipant {
  /** Starts Host shutdown and must return promptly; same-thread blocking cannot be bounded. */
  stop(): void | Promise<void>
}

/** Cleanup lane whose foreign settlement requires a mechanism-neutral bound. */
export type FixtureCleanupLane = 'fixture-begin' | 'host-stop'

/** Converts fixture-begin and Host-stop settlement into bounded results. */
export interface FixtureCleanupDeadline {
  /** @param lane Owned cleanup lane. @param operation Foreign settlement. @returns Settlement or expiry. */
  settle<T>(
    lane: FixtureCleanupLane,
    operation: Promise<T>,
  ): Promise<{ readonly status: 'settled'; readonly value: T } | { readonly status: 'expired' }>
}

/** Receives exact-once diagnostics for failures after bounded ownership transfer. */
export interface FixtureCleanupDiagnostics {
  /** Observes one Host rejection that arrives after its cleanup deadline expired. */
  hostStopRejected(error: unknown): void
  /** Observes one fixture-begin rejection after its deadline ownership was abandoned. */
  fixtureBeginRejected?(error: unknown): void
  /** Observes one fixture continuation rejection after begin ownership was abandoned. */
  fixtureContinuationRejected?(error: unknown): void
  /** Observes one non-quiescent fixture report after begin ownership was abandoned. */
  fixtureLateReport?(report: FixtureCleanupReport): void
}

/** Registers cleanup owners before exposing one memoized terminal cleanup result. */
export interface FixtureCleanupOwner {
  /** @param lease Exact fixture cleanup owner. @throws Synchronously on duplicate or late registration. */
  registerFixture(lease: OwnedFixtureLease): void
  /** @param host Exact Host cleanup participant. @throws Synchronously on duplicate or late registration. */
  registerHost(host: HostCleanupParticipant): void
  /**
   * @returns Exact memoized Promise that rejects for missing fixture registration, cleanup failure,
   * or non-quiescence.
   */
  cleanup(): Promise<FixtureCleanupReport>
}

/** One policy-ordered Host or fixture failure in a terminal cleanup rejection. */
export type FixtureCleanupErrorEntry =
  | { readonly kind: 'host'; readonly code: 'host-stop-failed' | 'host-stop-expired'; readonly message: string }
  | { readonly kind: 'fixture'; readonly issue: FixtureCleanupIssue }

/** Stable aggregate rejection with policy-ordered typed entries and the final report. */
export class FixtureCleanupError extends AggregateError {
  readonly entries: readonly FixtureCleanupErrorEntry[]
  readonly report: FixtureCleanupReport

  /** @param entries Policy-ordered failures. @param report Final fixture cleanup report. */
  constructor(entries: readonly FixtureCleanupErrorEntry[], report: FixtureCleanupReport) {
    super(entries.map(entry => new Error(entryMessage(entry))), 'fixture cleanup did not reach verified quiescence')
    this.name = 'FixtureCleanupError'
    this.entries = entries
    this.report = report
  }
}

const PHASE_ORDER: Readonly<Record<FixtureCleanupPhase, number>> = {
  graceful: 0,
  settle: 1,
  force: 2,
  final: 3,
}

/**
 * Creates the policy owner for one fixture lease and an optional Host participant.
 *
 * Cleanup mechanisms remain private to the lease Adapter. The owner publishes cleanup before
 * foreign calls, bounds the graceful begin barrier, then starts bounded Host stop after that barrier's
 * settlement, expiry, or failure. A prompt continuation remains the terminal quiescence owner.
 *
 * @param deadline Adapter that bounds fixture-begin and Host-stop settlement.
 * @param diagnostics Sink for exact-once failures observed after bounded ownership transfer.
 * @returns An owner that rejects duplicate or late registration and memoizes cleanup.
 */
export function createFixtureCleanupOwner(
  deadline: FixtureCleanupDeadline,
  diagnostics: FixtureCleanupDiagnostics = { hostStopRejected() {} },
): FixtureCleanupOwner {
  let lease: OwnedFixtureLease | undefined
  let host: HostCleanupParticipant | undefined
  let cleanupPromise: Promise<FixtureCleanupReport> | undefined

  return {
    registerFixture(candidate) {
      if (cleanupPromise !== undefined) throw new Error('cannot register fixture after cleanup started')
      if (lease !== undefined) throw new Error('fixture lease is already registered')
      lease = candidate
    },

    registerHost(candidate) {
      if (cleanupPromise !== undefined) throw new Error('cannot register Host after cleanup started')
      if (host !== undefined) throw new Error('Host cleanup participant is already registered')
      host = candidate
    },

    cleanup() {
      if (cleanupPromise !== undefined) return cleanupPromise
      if (lease === undefined) {
        cleanupPromise = Promise.reject(new Error('fixture lease must be registered before cleanup'))
        return cleanupPromise
      }
      const ownedLease = lease
      const registeredHost = host
      cleanupPromise = Promise.resolve().then(() => runCleanup(ownedLease, registeredHost, deadline, diagnostics))
      return cleanupPromise
    },
  }
}

async function runCleanup(
  lease: OwnedFixtureLease,
  host: HostCleanupParticipant | undefined,
  deadline: FixtureCleanupDeadline,
  diagnostics: FixtureCleanupDiagnostics,
): Promise<FixtureCleanupReport> {
  const begin = startFixtureBegin(lease)
  let continuation: FixtureCleanupContinuation | undefined
  let gracefulIssue: FixtureCleanupIssue | undefined
  try {
    const result = await deadline.settle('fixture-begin', begin)
    switch (result.status) {
      case 'expired':
        observeAbandonedFixtureBegin(begin, diagnostics)
        gracefulIssue = { phase: 'graceful', code: 'graceful-failed', message: 'fixture cleanup begin expired' }
        break
      case 'settled': continuation = result.value; break
      default: return assertNever(result)
    }
  } catch (error) {
    observeAbandonedFixtureBegin(begin, diagnostics, error)
    gracefulIssue = { phase: 'graceful', code: 'graceful-failed', message: errorMessage(error) }
  }

  const hostLane = settleHost(host, deadline, diagnostics)
  const fixtureLane = settleContinuation(continuation, gracefulIssue)
  const [hostResult, fixtureResult] = await Promise.allSettled([hostLane, fixtureLane])

  const hostEntries: FixtureCleanupErrorEntry[] = hostResult.status === 'fulfilled'
    ? hostResult.value === undefined ? [] : [hostResult.value]
    : [{ kind: 'host', code: 'host-stop-failed', message: errorMessage(hostResult.reason) }]
  const report = fixtureResult.status === 'fulfilled'
    ? fixtureResult.value
    : reportWithIssue({ phase: 'final', code: 'final-failed', message: errorMessage(fixtureResult.reason) })
  const fixtureEntries = orderedIssues(report.issues).map(issue => ({ kind: 'fixture', issue }) as const)

  if (hostEntries.length > 0 || fixtureEntries.length > 0 || !report.quiescent) {
    throw new FixtureCleanupError([...hostEntries, ...fixtureEntries], report)
  }
  return report
}

function startFixtureBegin(lease: OwnedFixtureLease): Promise<FixtureCleanupContinuation> {
  try {
    return Promise.resolve(lease.beginCleanup())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

function observeAbandonedFixtureBegin(
  begin: Promise<FixtureCleanupContinuation>,
  diagnostics: FixtureCleanupDiagnostics,
  surfacedError?: unknown,
): void {
  void begin.then(
    (continuation) => {
      void continuation.settled.then(
        (report) => {
          if (!report.quiescent || report.issues.length > 0) observeFixtureLateReport(diagnostics, report)
        },
        (error: unknown) => { observeFixtureContinuationFailure(diagnostics, error) },
      )
    },
    (error: unknown) => {
      if (!Object.is(error, surfacedError)) observeFixtureBeginFailure(diagnostics, error)
    },
  )
}

function observeFixtureBeginFailure(diagnostics: FixtureCleanupDiagnostics, error: unknown): void {
  try {
    diagnostics.fixtureBeginRejected?.(error)
  } catch {
    // The begin rejection is already observed; only its diagnostic callback failed.
  }
}

function observeFixtureContinuationFailure(diagnostics: FixtureCleanupDiagnostics, error: unknown): void {
  try {
    diagnostics.fixtureContinuationRejected?.(error)
  } catch {
    // The continuation rejection is already observed; only its diagnostic callback failed.
  }
}

function observeFixtureLateReport(diagnostics: FixtureCleanupDiagnostics, report: FixtureCleanupReport): void {
  try {
    diagnostics.fixtureLateReport?.(report)
  } catch {
    // The late report is already observed; only its diagnostic callback failed.
  }
}

async function settleHost(
  host: HostCleanupParticipant | undefined,
  deadline: FixtureCleanupDeadline,
  diagnostics: FixtureCleanupDiagnostics,
): Promise<FixtureCleanupErrorEntry | undefined> {
  if (host === undefined) return undefined
  let stop: Promise<void>
  try {
    stop = Promise.resolve(host.stop())
  } catch (error) {
    return { kind: 'host', code: 'host-stop-failed', message: errorMessage(error) }
  }
  let state: 'owned' | 'abandoned' | 'surfaced' = 'owned'
  let hasPendingRejection = false
  let pendingRejection: unknown
  let lateFailureObserved = false
  const observedStop = stop.catch((error: unknown) => {
    hasPendingRejection = true
    pendingRejection = error
    if (state === 'abandoned' && !lateFailureObserved) {
      lateFailureObserved = true
      observeLateHostFailure(diagnostics, error)
    }
    throw error
  })
  void observedStop.catch(() => {
    // The first observer owns rejection state; this continuation prevents an unhandled branch.
  })
  try {
    const outcome = await deadline.settle('host-stop', observedStop)
    switch (outcome.status) {
      case 'expired':
        state = 'abandoned'
        if (hasPendingRejection && !lateFailureObserved) {
          lateFailureObserved = true
          observeLateHostFailure(diagnostics, pendingRejection)
        }
        return { kind: 'host', code: 'host-stop-expired', message: 'Host stop did not settle before its deadline' }
      case 'settled':
        state = 'surfaced'
        return undefined
      default: return assertNever(outcome)
    }
  } catch (error) {
    if (hasPendingRejection && Object.is(error, pendingRejection)) {
      state = 'surfaced'
      return { kind: 'host', code: 'host-stop-failed', message: errorMessage(error) }
    }
    state = 'abandoned'
    if (hasPendingRejection && !lateFailureObserved) {
      lateFailureObserved = true
      observeLateHostFailure(diagnostics, pendingRejection)
    }
    return { kind: 'host', code: 'host-stop-failed', message: errorMessage(error) }
  }
}

function observeLateHostFailure(diagnostics: FixtureCleanupDiagnostics, error: unknown): void {
  try {
    diagnostics.hostStopRejected(error)
  } catch {
    // Swallow only a diagnostic callback failure; Host rejection ownership is already satisfied.
  }
}

async function settleContinuation(
  continuation: FixtureCleanupContinuation | undefined,
  gracefulIssue: FixtureCleanupIssue | undefined,
): Promise<FixtureCleanupReport> {
  if (continuation === undefined) return reportWithIssue(gracefulIssue ?? {
    phase: 'graceful',
    code: 'graceful-failed',
    message: 'fixture cleanup begin failed without an issue',
  })
  try {
    const report = await continuation.settled
    const issues = [...report.issues]
    if (!report.quiescent && !issues.some(issue => issue.code === 'fixture-not-quiescent')) {
      issues.push({ phase: 'final', code: 'fixture-not-quiescent', message: 'fixture did not reach verified quiescence' })
    }
    return Object.freeze({ ...report, issues: Object.freeze(orderedIssues(issues)) })
  } catch (error) {
    return reportWithIssue({ phase: 'final', code: 'final-failed', message: errorMessage(error) })
  }
}

function reportWithIssue(issue: FixtureCleanupIssue): FixtureCleanupReport {
  return Object.freeze({
    quiescent: false,
    forced: false,
    issues: Object.freeze([issue]),
  })
}

function orderedIssues(issues: readonly FixtureCleanupIssue[]): FixtureCleanupIssue[] {
  return issues.map((issue, index) => ({ issue, index }))
    .sort((left, right) => PHASE_ORDER[left.issue.phase] - PHASE_ORDER[right.issue.phase] || left.index - right.index)
    .map(({ issue }) => issue)
}

function entryMessage(entry: FixtureCleanupErrorEntry): string {
  switch (entry.kind) {
    case 'host': return entry.message
    case 'fixture': return entry.issue.message
    default: return assertNever(entry)
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected cleanup entry: ${String(value)}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
