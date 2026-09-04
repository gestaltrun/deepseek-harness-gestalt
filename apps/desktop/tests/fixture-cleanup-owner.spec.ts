import { describe, expect, it, vi } from 'vitest'
import {
  createFixtureCleanupOwner,
  FixtureCleanupError,
  type FixtureCleanupIssue,
  type FixtureCleanupContinuation,
  type FixtureCleanupReport,
  type HostLateFailureDiagnostics,
  type HostStopDeadline,
  type OwnedFixtureLease,
} from './helpers/fixture-cleanup-owner.ts'

const SUCCESS: FixtureCleanupReport = {
  quiescent: true,
  forced: false,
  issues: [],
}

function controlled<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function lease(beginCleanup: OwnedFixtureLease['beginCleanup']): OwnedFixtureLease {
  return { beginCleanup: vi.fn(beginCleanup) }
}

function deadline(settle: HostStopDeadline['settle'] = async (stop) => {
  await stop
  return 'settled'
}): HostStopDeadline {
  return { settle: vi.fn(settle) }
}

async function cleanupError(promise: Promise<FixtureCleanupReport>): Promise<FixtureCleanupError> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(FixtureCleanupError)
  return error as FixtureCleanupError
}

describe('fixture cleanup owner', () => {
  it('awaits the begin barrier before invoking Host stop', async () => {
    const begin = controlled<FixtureCleanupContinuation>()
    const owner = createFixtureCleanupOwner(deadline())
    const host = { stop: vi.fn() }
    owner.registerFixture(lease(() => begin.promise))
    owner.registerHost(host)

    const cleanup = owner.cleanup()
    await Promise.resolve()
    expect(host.stop).not.toHaveBeenCalled()
    begin.resolve({ settled: Promise.resolve(SUCCESS) })
    await cleanup
    expect(host.stop).toHaveBeenCalledOnce()
  })

  it('invokes Host and aggregates when begin rejects', async () => {
    const owner = createFixtureCleanupOwner(deadline())
    const host = { stop: vi.fn(() => { throw new Error('host failed') }) }
    owner.registerFixture(lease(async () => { throw new Error('graceful failed') }))
    owner.registerHost(host)

    const error = await cleanupError(owner.cleanup())

    expect(host.stop).toHaveBeenCalledOnce()
    expect(error.entries).toEqual([
      { kind: 'host', code: 'host-stop-failed', message: 'host failed' },
      { kind: 'fixture', issue: { phase: 'graceful', code: 'graceful-failed', message: 'graceful failed' } },
    ])
  })

  it('settles Host and fixture continuation independently', async () => {
    const continuationSettlement = controlled<FixtureCleanupReport>()
    const hostStop = controlled<undefined>()
    const deadlineAdapter = deadline(async (stop) => {
      await stop
      return 'settled'
    })
    const owner = createFixtureCleanupOwner(deadlineAdapter)
    owner.registerFixture(lease(async () => ({ settled: continuationSettlement.promise })))
    owner.registerHost({ stop: () => hostStop.promise })

    const cleanup = owner.cleanup()
    await Promise.resolve()
    continuationSettlement.resolve(SUCCESS)
    await Promise.resolve()
    let settled = false
    void cleanup.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    hostStop.resolve(undefined)
    await cleanup
  })

  it('bounds a never-settling Host while fixture finishes', async () => {
    const deadlineAdapter = deadline(async () => 'expired')
    const owner = createFixtureCleanupOwner(deadlineAdapter)
    owner.registerFixture(lease(async () => ({ settled: Promise.resolve(SUCCESS) })))
    owner.registerHost({ stop: () => new Promise<void>(() => {}) })

    const error = await cleanupError(owner.cleanup())

    expect(error.entries).toEqual([
      { kind: 'host', code: 'host-stop-expired', message: 'Host stop did not settle before its deadline' },
    ])
    expect(error.report).toEqual(SUCCESS)
  })

  it('observes one late Host rejection after expiry', async () => {
    const hostStop = controlled<undefined>()
    const hostStopRejected = vi.fn()
    const diagnostics: HostLateFailureDiagnostics = { hostStopRejected }
    const owner = createFixtureCleanupOwner(deadline(async () => 'expired'), diagnostics)
    owner.registerFixture(lease(async () => ({ settled: Promise.resolve(SUCCESS) })))
    owner.registerHost({ stop: () => hostStop.promise })

    await cleanupError(owner.cleanup())
    hostStop.reject(new Error('late Host failure'))
    await Promise.resolve()

    expect(hostStopRejected).toHaveBeenCalledOnce()
    expect(hostStopRejected).toHaveBeenCalledWith(expect.objectContaining({ message: 'late Host failure' }))
  })

  it('contains a throwing late Host diagnostic without changing cleanup settlement', async () => {
    const hostStop = controlled<undefined>()
    const hostStopRejected = vi.fn(() => { throw new Error('diagnostic failed') })
    const diagnostics: HostLateFailureDiagnostics = { hostStopRejected }
    const owner = createFixtureCleanupOwner(deadline(async () => 'expired'), diagnostics)
    owner.registerFixture(lease(async () => ({ settled: Promise.resolve(SUCCESS) })))
    owner.registerHost({ stop: () => hostStop.promise })

    const error = await cleanupError(owner.cleanup())
    hostStop.reject(new Error('late Host failure'))
    await Promise.resolve()

    expect(error.entries).toEqual([
      { kind: 'host', code: 'host-stop-expired', message: 'Host stop did not settle before its deadline' },
    ])
    expect(hostStopRejected).toHaveBeenCalledOnce()
  })

  it('waits for later continuation rejection after early Host expiry and aggregates both', async () => {
    const continuationSettlement = controlled<FixtureCleanupReport>()
    const owner = createFixtureCleanupOwner(deadline(async () => 'expired'))
    owner.registerFixture(lease(async () => ({ settled: continuationSettlement.promise })))
    owner.registerHost({ stop: () => new Promise<void>(() => {}) })

    const cleanup = owner.cleanup()
    let settled = false
    void cleanup.catch(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    continuationSettlement.reject(new Error('settled failed'))
    const error = await cleanupError(cleanup)

    expect(error.entries).toEqual([
      { kind: 'host', code: 'host-stop-expired', message: 'Host stop did not settle before its deadline' },
      { kind: 'fixture', issue: { phase: 'final', code: 'final-failed', message: 'settled failed' } },
    ])
  })

  it('returns a force-required forced success report', async () => {
    const report: FixtureCleanupReport = { quiescent: true, forced: true, issues: [] }
    const owner = createFixtureCleanupOwner(deadline())
    owner.registerFixture(lease(async () => ({ settled: Promise.resolve(report) })))

    await expect(owner.cleanup()).resolves.toEqual(report)
  })

  it('requires verified quiescence for success', async () => {
    const report = { ...SUCCESS, quiescent: false }
    const owner = createFixtureCleanupOwner(deadline())
    owner.registerFixture(lease(async () => ({ settled: Promise.resolve(report) })))

    const error = await cleanupError(owner.cleanup())

    expect(error.entries).toEqual([
      { kind: 'fixture', issue: { phase: 'final', code: 'fixture-not-quiescent', message: 'fixture did not reach verified quiescence' } },
    ])
  })

  it('orders typed issues as host then graceful, settle, force, final', async () => {
    const issues: FixtureCleanupIssue[] = [
      { phase: 'final', code: 'final-failed', message: 'final' },
      { phase: 'force', code: 'force-failed', message: 'force' },
      { phase: 'graceful', code: 'graceful-failed', message: 'graceful' },
      { phase: 'settle', code: 'settle-failed', message: 'settle' },
    ]
    const owner = createFixtureCleanupOwner(deadline())
    owner.registerFixture(lease(async () => ({
      settled: Promise.resolve({ quiescent: false, forced: true, issues }),
    })))
    owner.registerHost({ stop: () => { throw new Error('host') } })

    const error = await cleanupError(owner.cleanup())

    expect(error.entries.map(entry => entry.kind === 'host' ? entry.code : entry.issue.code)).toEqual([
      'host-stop-failed',
      'graceful-failed',
      'settle-failed',
      'force-failed',
      'final-failed',
      'fixture-not-quiescent',
    ])
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'host' }),
      expect.objectContaining({ message: 'graceful' }),
      expect.objectContaining({ message: 'settle' }),
      expect.objectContaining({ message: 'force' }),
      expect.objectContaining({ message: 'final' }),
      expect.objectContaining({ message: 'fixture did not reach verified quiescence' }),
    ])
  })

  it('memoizes the same cleanup Promise before foreign calls', async () => {
    const begin = controlled<FixtureCleanupContinuation>()
    const beginCleanup = vi.fn(() => begin.promise)
    const ownedLease = lease(beginCleanup)
    const owner = createFixtureCleanupOwner(deadline())
    owner.registerFixture(ownedLease)

    const first = owner.cleanup()
    expect(owner.cleanup()).toBe(first)
    await Promise.resolve()
    expect(beginCleanup).toHaveBeenCalledOnce()
    begin.resolve({ settled: Promise.resolve(SUCCESS) })
    await first
    expect(owner.cleanup()).toBe(first)
  })

  it('rejects duplicate and late registration synchronously', async () => {
    const owner = createFixtureCleanupOwner(deadline())
    const first = lease(async () => ({ settled: Promise.resolve(SUCCESS) }))
    const host = { stop() {} }
    owner.registerFixture(first)
    owner.registerHost(host)
    expect(() => { owner.registerFixture(first) }).toThrow(/already registered/)
    expect(() => { owner.registerHost(host) }).toThrow(/already registered/)
    const cleanup = owner.cleanup()
    expect(() => { owner.registerFixture(first) }).toThrow(/after cleanup started/)
    expect(() => { owner.registerHost({ stop() {} }) }).toThrow(/after cleanup started/)
    await cleanup
  })

  it('returns the same rejected Promise without a lease', async () => {
    const owner = createFixtureCleanupOwner(deadline())
    const first = owner.cleanup()
    expect(owner.cleanup()).toBe(first)
    await expect(first).rejects.toThrow(/must be registered/)
  })
})
