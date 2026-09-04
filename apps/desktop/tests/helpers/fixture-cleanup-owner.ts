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

/** Converts Host stop settlement into a bounded settled-or-expired result. */
export interface HostStopDeadline {
  /** Bounds one prompt-return Host stop promise without using ambient timers. */
  settle(stop: Promise<void>): Promise<'settled' | 'expired'>
}

/** Receives an exact-once diagnostic for a Host rejection after deadline expiry. */
export interface HostLateFailureDiagnostics {
  /** Observes one Host rejection that arrives after its cleanup deadline expired. */
  hostStopRejected(error: unknown): void
}

/** Registers cleanup owners before exposing one memoized terminal cleanup result. */
export interface FixtureCleanupOwner {
  registerFixture(lease: OwnedFixtureLease): void
  registerHost(host: HostCleanupParticipant): void
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
 * foreign calls, awaits the graceful begin barrier before stopping Host, then independently settles
 * bounded Host stop and the lease's mechanism-neutral verified-quiescence report.
 *
 * @param deadline Adapter that bounds Host stop settlement.
 * @param diagnostics Sink for an exact-once rejection observed after Host deadline expiry.
 * @returns An owner that rejects duplicate or late registration and memoizes cleanup.
 */
export function createFixtureCleanupOwner(
  deadline: HostStopDeadline,
  diagnostics: HostLateFailureDiagnostics = { hostStopRejected() {} },
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
  deadline: HostStopDeadline,
  diagnostics: HostLateFailureDiagnostics,
): Promise<FixtureCleanupReport> {
  let continuation: FixtureCleanupContinuation | undefined
  let gracefulIssue: FixtureCleanupIssue | undefined
  try {
    continuation = await lease.beginCleanup()
  } catch (error) {
    gracefulIssue = {
      phase: 'graceful',
      code: 'graceful-failed',
      message: errorMessage(error),
    }
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

async function settleHost(
  host: HostCleanupParticipant | undefined,
  deadline: HostStopDeadline,
  diagnostics: HostLateFailureDiagnostics,
): Promise<FixtureCleanupErrorEntry | undefined> {
  if (host === undefined) return undefined
  let stop: Promise<void>
  try {
    stop = Promise.resolve(host.stop())
  } catch (error) {
    return { kind: 'host', code: 'host-stop-failed', message: errorMessage(error) }
  }
  let expired = false
  let lateFailureObserved = false
  void stop.catch((error: unknown) => {
    if (!expired || lateFailureObserved) return
    lateFailureObserved = true
    try {
      diagnostics.hostStopRejected(error)
    } catch {
      // Swallow only a diagnostic callback failure; Host rejection ownership is already satisfied.
    }
  })
  try {
    const outcome = await deadline.settle(stop)
    if (outcome === 'expired') {
      expired = true
      return { kind: 'host', code: 'host-stop-expired', message: 'Host stop did not settle before its deadline' }
    }
    return undefined
  } catch (error) {
    return { kind: 'host', code: 'host-stop-failed', message: errorMessage(error) }
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
  return entry.kind === 'host' ? entry.message : entry.issue.message
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
