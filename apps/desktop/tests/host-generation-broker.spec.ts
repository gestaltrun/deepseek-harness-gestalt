import { describe, expect, it, vi } from 'vitest'
import {
  createHostGenerationOwner,
  HostGenerationCloseError,
  type BrokerLease,
  type BrokerReservation,
  type DesktopProtocolMessage,
  type HostGenerationBroker,
  type HostGenerationCapability,
  type HostGenerationChannel,
  type HostGenerationDeadline,
  type HostGenerationDiagnostics,
  type HostGenerationCloseIssue,
  type HostGenerationId,
  type HostGenerationLane,
  type HostLeaseId,
  type InitializedHostGeneration,
  type HostRequestId,
} from './helpers/host-generation-broker.ts'

const GENERATION_A = 'generation-a' as HostGenerationId
const GENERATION_B = 'generation-b' as HostGenerationId
const CAPABILITY_A = 'capability-a' as HostGenerationCapability
const CAPABILITY_B = 'capability-b' as HostGenerationCapability
const HELLO_A = 'hello-a' as HostRequestId
const SPAWN_A = 'spawn-a' as HostRequestId
const STOP_A = 'stop-a' as HostRequestId
const LEASE_A = 'lease-a' as HostLeaseId

function hello(request = HELLO_A) {
  return { version: 1, type: 'host-hello', request }
}

function spawn(request = SPAWN_A, generation = GENERATION_A, capability = CAPABILITY_A) {
  return { version: 1, type: 'spawn-request', request, generation, capability }
}

function stop(request = STOP_A, lease = LEASE_A, generation = GENERATION_A, capability = CAPABILITY_A) {
  return { version: 1, type: 'stop-request', request, lease, generation, capability }
}

function channel() {
  const emit = vi.fn<(message: DesktopProtocolMessage) => void>()
  return { value: { emit } satisfies HostGenerationChannel, emit }
}

function diagnostics() {
  const callbackFailed = vi.fn()
  const lateFailure = vi.fn()
  const lateCleanupIssue = vi.fn()
  const leaseExitFailed = vi.fn()
  return {
    value: { callbackFailed, lateFailure, lateCleanupIssue, leaseExitFailed } satisfies HostGenerationDiagnostics,
    callbackFailed, lateFailure, lateCleanupIssue, leaseExitFailed,
  }
}

function deadline(handler?: HostGenerationDeadline['settle']): HostGenerationDeadline {
  const settle: HostGenerationDeadline['settle'] = handler ?? (async <T>(_lane: unknown, operation: Promise<T>) => ({
    status: 'settled',
    value: await operation,
  }))
  return { settle }
}

function identityFactory() {
  const mint = vi.fn()
    .mockReturnValueOnce({ generation: GENERATION_A, capability: CAPABILITY_A })
    .mockReturnValueOnce({ generation: GENERATION_B, capability: CAPABILITY_B })
  return { value: { mint }, mint }
}

function controlled<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function fakeLease(id = LEASE_A) {
  const stopCleanup = controlled<Awaited<ReturnType<BrokerLease['stop']>>>()
  const stop = vi.fn(() => stopCleanup.promise)
  const exited = controlled<undefined>()
  const lease: BrokerLease = { id, exited: exited.promise, stop }
  return { lease, stop, stopCleanup, exited }
}

function broker(reserve: HostGenerationBroker['reserve']) {
  return { value: { reserve: vi.fn(reserve) } satisfies HostGenerationBroker }
}

function initialized(
  fakeBroker: HostGenerationBroker,
  options: {
    channel?: HostGenerationChannel
    deadline?: HostGenerationDeadline
    diagnostics?: HostGenerationDiagnostics
    host?: { stop(): void | Promise<void> }
  } = {},
): InitializedHostGeneration {
  const owner = createHostGenerationOwner(
    'available',
    identityFactory().value,
    fakeBroker,
    options.deadline ?? deadline(),
    { maxRememberedRequests: 256 },
    options.diagnostics ?? diagnostics().value,
  )
  const generation = owner.hello(options.channel ?? channel().value, hello(), options.host)
  if (!('disconnect' in generation)) throw new Error('expected initialized generation')
  return generation
}

async function closeError(generation: InitializedHostGeneration): Promise<HostGenerationCloseError> {
  return closeErrorFromPromise(generation.cleanup())
}

async function closeErrorFromPromise(close: Promise<unknown>): Promise<HostGenerationCloseError> {
  const error: unknown = await close.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(HostGenerationCloseError)
  return error as HostGenerationCloseError
}

function closeIssueLabel(issue: HostGenerationCloseIssue): string {
  switch (issue.kind) {
    case 'collision': return `${issue.kind}:${issue.request}`
    case 'lease': return `${issue.kind}:${issue.issue.message}`
    case 'host': return `${issue.kind}:${issue.message}`
    case 'reservation': return `${issue.kind}:${issue.message}`
    default: return assertNeverCloseIssue(issue)
  }
}

function assertNeverCloseIssue(value: never): never {
  throw new Error(`unexpected close issue: ${String(value)}`)
}

describe('Host generation broker policy', () => {
  it('returns malformed request parsing as Promise rejection without synchronous throw', async () => {
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => fakeLease().lease, cancel() {} })).value)
    let request: Promise<void> | undefined

    expect(() => { request = generation.request({ version: 1, type: 'spawn-request' }) }).not.toThrow()
    await expect(request).rejects.toThrow(/unknown or missing fields/)
  })

  it('mints authority after a bounded correlated hello and rejects unknown fields', () => {
    const identities = identityFactory()
    const output = channel()
    const owner = createHostGenerationOwner(
      'available', identities.value, broker(() => ({ id: LEASE_A, start: async () => fakeLease().lease, cancel() {} })).value, deadline(), { maxRememberedRequests: 256 }, diagnostics().value,
    )

    owner.hello(output.value, hello())

    expect(identities.mint).toHaveBeenCalledOnce()
    expect(output.emit).toHaveBeenCalledWith({
      version: 1, type: 'desktop-initialized', request: HELLO_A, generation: GENERATION_A, capability: CAPABILITY_A,
    })
    expect(() => owner.hello(channel().value, { ...hello(), generation: GENERATION_B })).toThrow(/unknown or missing/)
    expect(() => owner.hello(channel().value, { ...hello(), request: '' })).toThrow(/bounded non-empty/)
  })

  it('correlates platform containment unavailability without minting authority', () => {
    const identities = identityFactory()
    const output = channel()
    const result = createHostGenerationOwner(
      'unavailable', identities.value, broker(() => ({ id: LEASE_A, start: async () => fakeLease().lease, cancel() {} })).value, deadline(), { maxRememberedRequests: 256 }, diagnostics().value,
    ).hello(output.value, hello())

    expect(identities.mint).not.toHaveBeenCalled()
    expect(result).toEqual({ version: 1, type: 'desktop-unsupported', request: HELLO_A, reason: 'PLATFORM_CONTAINMENT_UNAVAILABLE' })
  })

  it('permits one handshake per exact channel and mints independently on another channel', () => {
    const identities = identityFactory()
    const owner = createHostGenerationOwner(
      'available', identities.value, broker(() => ({ id: LEASE_A, start: async () => fakeLease().lease, cancel() {} })).value, deadline(), { maxRememberedRequests: 256 }, diagnostics().value,
    )
    const first = channel()
    owner.hello(first.value, hello())
    expect(() => owner.hello(first.value, hello())).toThrow(/already initialized/)
    const second = channel()
    owner.hello(second.value, hello())
    expect(second.emit).toHaveBeenCalledWith(expect.objectContaining({ generation: GENERATION_B, capability: CAPABILITY_B }))
  })

  it('sets closing and publishes the exact Promise before same-stack reentry', async () => {
    let generation = undefined as InitializedHostGeneration | undefined
    let reenteredClose: Promise<unknown> | undefined
    let reenteredRequest: Promise<void> | undefined
    const host = { stop: vi.fn(() => {
      reenteredClose = generation?.cleanup()
      reenteredRequest = generation?.request(spawn())
    }) }
    generation = initialized(broker(() => ({ id: LEASE_A, start: async () => fakeLease().lease, cancel() {} })).value, { host })
    const close = generation.cleanup()

    await expect(generation?.request(spawn())).rejects.toThrow(/closing/)
    await close
    expect(reenteredClose).toBe(close)
    await expect(reenteredRequest).rejects.toThrow(/closing/)
    expect(generation?.hostExited()).toBe(close)
  })

  it.each(['reserve', 'start'] as const)('publishes reservation before synchronous %s reentry', async (phase) => {
    let generation = undefined as InitializedHostGeneration | undefined
    let reentry: Promise<void> | undefined
    const reservation: BrokerReservation = {
      id: LEASE_A,
      cancel() {},
      start: () => {
        if (phase === 'start') reentry = generation?.request(spawn())
        return Promise.resolve(fakeLease().lease)
      },
    }
    generation = initialized(broker(() => {
      if (phase === 'reserve') reentry = generation?.request(spawn())
      return reservation
    }).value)

    await generation?.request(spawn())
    await expect(reentry).rejects.toThrow(/duplicate Host request/)
  })

  it('bounds a hanging start while Host and existing lease cleanup proceed', async () => {
    const hanging = controlled<BrokerLease>()
    const existing = fakeLease()
    existing.stopCleanup.resolve({ quiescent: true, issues: [] })
    let calls = 0
    const reservationPublished = controlled<undefined>()
    const fakeBroker = broker(() => {
      calls += 1
      if (calls === 2) reservationPublished.resolve(undefined)
      return {
        id: calls === 1 ? existing.lease.id : LEASE_A,
        start: () => calls === 1 ? Promise.resolve(existing.lease) : hanging.promise,
        cancel() {},
      }
    })
    const lanes: string[] = []
    const bounded = deadline(async (lane, operation) => {
      lanes.push(lane.kind)
      if (lane.kind === 'reservation') return { status: 'expired' }
      return { status: 'settled', value: await operation }
    })
    const hostStop = vi.fn()
    const generation = initialized(fakeBroker.value, { deadline: bounded, host: { stop: hostStop } })
    await generation.request(spawn('spawn-existing' as HostRequestId))
    void generation.request(spawn('spawn-hanging' as HostRequestId))
    await reservationPublished.promise

    await closeError(generation)
    expect(hostStop).toHaveBeenCalledOnce()
    expect(existing.stop).toHaveBeenCalledOnce()
    expect(lanes).toEqual(['host', 'lease', 'reservation'])

    const late = fakeLease('late' as HostLeaseId)
    late.stopCleanup.resolve({ quiescent: true, issues: [] })
    hanging.resolve(late.lease)
    await Promise.resolve()
    await Promise.resolve()
    expect(late.stop).toHaveBeenCalledOnce()
  })

  it('fails closed at replay capacity without evicting earlier requests', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    const owner = createHostGenerationOwner(
      'available', identityFactory().value,
      broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value,
      deadline(), { maxRememberedRequests: 1 }, diagnostics().value,
    )
    const generation = owner.hello(channel().value, hello())
    if (!('disconnect' in generation)) throw new Error('expected initialized generation')
    await generation.request(spawn('first' as HostRequestId))

    await expect(generation.request(stop('second' as HostRequestId))).rejects.toThrow(/capacity reached/)
    await expect(generation.request(spawn('first' as HostRequestId))).rejects.toThrow(/closing|duplicate/)
  })

  it('capacity refusal starts exact memoized close before a second spawn reaches broker', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    const reserve = vi.fn(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} }))
    const hostStop = vi.fn()
    const owner = createHostGenerationOwner(
      'available', identityFactory().value, { reserve }, deadline(),
      { maxRememberedRequests: 1 }, diagnostics().value,
    )
    const generation = owner.hello(channel().value, hello(), { stop: hostStop })
    if (!('disconnect' in generation)) throw new Error('expected initialized generation')
    await generation.request(spawn('first' as HostRequestId))

    await expect(generation.request(spawn('capacity' as HostRequestId))).rejects.toThrow(/capacity reached/)
    const close = generation.cleanup()
    expect(generation.disconnect()).toBe(close)
    await close

    expect(reserve).toHaveBeenCalledExactlyOnceWith('first')
    expect(hostStop).toHaveBeenCalledOnce()
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
  })

  it('rejects same stop request reentry before a second foreign cleanup call', async () => {
    const cleanup = controlled<Awaited<ReturnType<BrokerLease['stop']>>>()
    let generation = undefined as InitializedHostGeneration | undefined
    let reentry: Promise<unknown> | undefined
    const stopEntered = controlled<undefined>()
    const stopLease = vi.fn(() => {
      reentry = generation?.request(stop()).catch((error: unknown) => error)
      stopEntered.resolve(undefined)
      return cleanup.promise
    })
    const owned: BrokerLease = { id: LEASE_A, exited: new Promise<void>(() => {}), stop: stopLease }
    generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned, cancel() {} })).value)
    await generation.request(spawn())

    const first = generation.request(stop())
    await stopEntered.promise
    await expect(reentry).resolves.toEqual(expect.objectContaining({ message: 'duplicate Host request' }))
    cleanup.resolve({ quiescent: true, issues: [] })
    await first
    expect(stopLease).toHaveBeenCalledOnce()
  })

  it('memoizes exact lease cleanup for repeated correlated stop requests', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    const output = channel()
    const generation = initialized(
      broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value,
      { channel: output.value },
    )
    await generation.request(spawn())

    await Promise.all([
      generation.request(stop('stop-1' as HostRequestId)),
      generation.request(stop('stop-2' as HostRequestId)),
    ])

    expect(owned.stop).toHaveBeenCalledOnce()
    const stopped = output.emit.mock.calls
      .map(([message]) => message)
      .filter((message): message is Extract<DesktopProtocolMessage, { type: 'stopped' }> => message.type === 'stopped')
    expect(stopped.filter(message => message.request === 'stop-1')).toHaveLength(1)
    expect(stopped.filter(message => message.request === 'stop-2')).toHaveLength(1)
    owned.exited.resolve(undefined)
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('retires the lease before stopped emit reentry can request it again', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    let generation = undefined as InitializedHostGeneration | undefined
    let reentry: Promise<unknown> | undefined
    const output: HostGenerationChannel = {
      emit(message) {
        if (message.type === 'stopped' && reentry === undefined) {
          reentry = generation?.request(stop('emit-reentry' as HostRequestId))
        }
      },
    }
    generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value, {
      channel: output,
    })
    await generation.request(spawn())

    await generation.request(stop('first-stop' as HostRequestId))

    await expect(reentry).rejects.toThrow(/does not belong/)
    expect(generation.ownershipSnapshot().leases).toBe(0)
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('allows a new lease to reuse a retired lease id without collision', async () => {
    const first = fakeLease()
    const replacement = fakeLease()
    first.stopCleanup.resolve({ quiescent: true, issues: [] })
    replacement.stopCleanup.resolve({ quiescent: true, issues: [] })
    let starts = 0
    const output = channel()
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: async () => ++starts === 1 ? first.lease : replacement.lease,
      cancel() {},
    })).value, { channel: output.value })
    await generation.request(spawn('first-lease' as HostRequestId))
    await generation.request(stop('retire-first' as HostRequestId))

    await generation.request(spawn('replacement-lease' as HostRequestId))

    expect(output.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawned', request: 'replacement-lease', lease: LEASE_A,
    }))
    expect(output.emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawn-rejected', request: 'replacement-lease',
    }))
    await generation.cleanup()
    expect(first.stop).toHaveBeenCalledOnce()
    expect(replacement.stop).toHaveBeenCalledOnce()
  })

  it('removes a successfully stopped lease before emit and close does not stop it again', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value)
    await generation.request(spawn())

    await generation.request(stop())

    expect(generation.ownershipSnapshot().leases).toBe(0)
    await generation.cleanup()
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('does not emit stopped when close snapshots a pending stop', async () => {
    const owned = fakeLease()
    const output = channel()
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value, {
      channel: output.value,
    })
    await generation.request(spawn())
    const request = generation.request(stop())
    await expect.poll(() => owned.stop.mock.calls.length).toBe(1)
    const close = generation.cleanup()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })

    await Promise.all([request, close])

    expect(output.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stopped' }))
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('publishes the bounded lease settlement before synchronous deadline reentry', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    let generation = undefined as InitializedHostGeneration | undefined
    let reentered: Promise<unknown> | undefined
    const settleOperation: HostGenerationDeadline['settle'] = async <T>(
      lane: HostGenerationLane,
      operation: Promise<T>,
    ) => {
      if (lane.kind === 'lease' && reentered === undefined) reentered = generation?.cleanup()
      return { status: 'settled', value: await operation }
    }
    const settle = settleOperation
    generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value, {
      deadline: { settle },
    })
    await generation.request(spawn())

    await generation.request(stop())
    await reentered

    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('natural exit success does not settle or multiply pending cleanup', async () => {
    const owned = fakeLease()
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value)
    await generation.request(spawn())
    const close = generation.cleanup()

    owned.exited.resolve(undefined)
    let closeSettled = false
    void close.then(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    expect(owned.stop).toHaveBeenCalledOnce()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    await close
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('observes natural exit rejection without changing cleanup ownership', async () => {
    const observed = diagnostics()
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value, {
      diagnostics: observed.value,
    })
    await generation.request(spawn())

    owned.exited.reject(new Error('exit observation failed'))
    await expect.poll(() => observed.leaseExitFailed.mock.calls.length).toBe(1)
    await generation.cleanup()

    expect(owned.stop).toHaveBeenCalledOnce()
    expect(observed.leaseExitFailed).toHaveBeenCalledExactlyOnceWith(
      LEASE_A, expect.objectContaining({ message: 'exit observation failed' }),
    )
    expect(observed.lateFailure).not.toHaveBeenCalled()
  })

  it('rejects cross-generation lease addressing', async () => {
    const owned = fakeLease()
    const generationA = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value)
    await generationA.request(spawn())
    await expect(generationA.request(stop(STOP_A, LEASE_A, GENERATION_B, CAPABILITY_A))).rejects.toThrow(/does not belong/)
    await expect(generationA.request(stop('wrong-capability' as HostRequestId, LEASE_A, GENERATION_A, CAPABILITY_B))).rejects.toThrow(/does not belong/)
  })

  it('cleans a duplicate lease without overwriting the first owner', async () => {
    const first = fakeLease()
    const collision = fakeLease()
    first.stopCleanup.resolve({ quiescent: true, issues: [] })
    collision.stopCleanup.resolve({ quiescent: true, issues: [] })
    let calls = 0
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: async () => ++calls === 1 ? first.lease : collision.lease,
      cancel() {},
    })).value)
    await generation.request(spawn('spawn-1' as HostRequestId))
    await generation.request(spawn('spawn-2' as HostRequestId))

    const error = await closeError(generation)
    expect(error.report.issues.filter(issue => issue.kind === 'collision' && issue.code === 'duplicate-lease')).toEqual([
      expect.objectContaining({ kind: 'collision', code: 'duplicate-lease', request: 'spawn-2' }),
    ])
    expect(first.stop).toHaveBeenCalledOnce()
    expect(collision.stop).toHaveBeenCalledOnce()
  })

  it('publishes collision cleanup before synchronous close reentry', async () => {
    const first = fakeLease()
    first.stopCleanup.resolve({ quiescent: true, issues: [] })
    const collisionCleanup = controlled<Awaited<ReturnType<BrokerLease['stop']>>>()
    let generation = undefined as InitializedHostGeneration | undefined
    let close: Promise<unknown> | undefined
    const closePublished = controlled<undefined>()
    const collisionStop = vi.fn(() => {
      close = generation?.cleanup()
      closePublished.resolve(undefined)
      return collisionCleanup.promise
    })
    const collision: BrokerLease = {
      id: LEASE_A,
      exited: new Promise<void>(() => {}),
      stop: collisionStop,
    }
    let calls = 0
    generation = initialized(broker(() => ({
      id: LEASE_A,
      start: async () => ++calls === 1 ? first.lease : collision,
      cancel() {},
    })).value)
    await generation.request(spawn('spawn-1' as HostRequestId))
    const duplicate = generation.request(spawn('spawn-2' as HostRequestId))
    await closePublished.promise

    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    const closeObserved = close?.catch((error: unknown) => error)
    expect(await Promise.race([closeObserved, Promise.resolve('pending')])).toBe('pending')
    collisionCleanup.resolve({ quiescent: true, issues: [] })
    await duplicate
    await expect(closeObserved).resolves.toBeInstanceOf(HostGenerationCloseError)
    expect(collisionStop).toHaveBeenCalledOnce()
  })

  it('groups every structural collision before all cleanup issues', async () => {
    const regular = fakeLease('regular' as HostLeaseId)
    const collisionOne = fakeLease('regular' as HostLeaseId)
    const collisionTwo = fakeLease('regular' as HostLeaseId)
    regular.stopCleanup.resolve({
      quiescent: true,
      issues: [{ phase: 'final', code: 'final-failed', message: 'owned-lease-cleanup' }],
    })
    collisionOne.stopCleanup.resolve({
      quiescent: true,
      issues: [{ phase: 'final', code: 'final-failed', message: 'collision-cleanup-1' }],
    })
    collisionTwo.stopCleanup.resolve({
      quiescent: true,
      issues: [{ phase: 'final', code: 'final-failed', message: 'collision-cleanup-2' }],
    })
    const sequence = [regular.lease, collisionOne.lease, collisionTwo.lease]
    let sequenceIndex = 0
    const generation = initialized(broker(() => ({
      id: regular.lease.id,
      start: async () => {
        const selected = sequence[sequenceIndex]
        sequenceIndex += 1
        if (selected === undefined) throw new Error('unexpected extra broker start')
        return selected
      },
      cancel() {},
    })).value)
    await generation.request(spawn('regular-request' as HostRequestId))
    await generation.request(spawn('collision-1' as HostRequestId))
    await generation.request(spawn('collision-2' as HostRequestId))

    const error = await closeError(generation)

    expect(error.report.issues.map(closeIssueLabel)).toEqual([
      'collision:collision-1',
      'collision:collision-2',
      'lease:collision-cleanup-1',
      'lease:collision-cleanup-2',
      'lease:owned-lease-cleanup',
    ])
  })

  it('normalizes non-quiescent empty broker reports', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({ quiescent: false, issues: [] })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value)
    await generation.request(spawn())

    const error = await closeError(generation)
    expect(error.report.issues).toContainEqual({
      kind: 'lease', lease: LEASE_A,
      issue: { phase: 'final', code: 'fixture-not-quiescent', message: 'broker lease did not reach verified quiescence' },
    })
  })

  it('does not acknowledge a duplicate lease and preserves its first owner', async () => {
    const output = channel()
    const first = fakeLease()
    const collision = fakeLease()
    first.stopCleanup.resolve({ quiescent: true, issues: [] })
    collision.stopCleanup.resolve({ quiescent: true, issues: [] })
    let calls = 0
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: async () => ++calls === 1 ? first.lease : collision.lease,
      cancel() {},
    })).value, { channel: output.value })
    await generation.request(spawn('spawn-1' as HostRequestId))
    await generation.request(spawn('spawn-2' as HostRequestId))

    expect(output.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'spawn-rejected', request: 'spawn-2' }))
    expect(output.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawned', request: 'spawn-2' }))
    await closeError(generation)
    expect(first.stop).toHaveBeenCalledOnce()
    expect(collision.stop).toHaveBeenCalledOnce()
  })

  it('cancels a reservation when reserve synchronously closes the generation', async () => {
    let generation = undefined as InitializedHostGeneration | undefined
    const cancel = vi.fn()
    const start = vi.fn(async () => fakeLease().lease)
    generation = initialized(broker(() => {
      void generation?.disconnect()
      return { id: LEASE_A, start, cancel }
    }).value)

    await generation.request(spawn())

    expect(cancel).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })

  it('reports rejecting cancellation after reserve synchronously reenters close', async () => {
    let generation = undefined as InitializedHostGeneration | undefined
    let reenteredClose: Promise<unknown> | undefined
    const cancel = vi.fn(() => Promise.reject(new Error('reentry cancel failed')))
    const reserve = vi.fn(() => {
      reenteredClose = generation?.cleanup()
      if (reenteredClose === undefined) throw new Error('generation not initialized')
      void reenteredClose.catch(() => undefined)
      return { id: LEASE_A, start: () => new Promise<BrokerLease>(() => {}), cancel }
    })
    generation = initialized({ reserve })

    const request = generation.request(spawn('reentry-cancel-reject' as HostRequestId))
    await expect.poll(() => reenteredClose !== undefined).toBe(true)
    const error = await closeErrorFromPromise(reenteredClose!)
    const [requestSettlement] = await Promise.allSettled([request])

    expect(requestSettlement).toBeDefined()
    expect(error.report.issues.map(closeIssueLabel)).toEqual(['reservation:reentry cancel failed'])
    expect(cancel).toHaveBeenCalledOnce()
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
  })

  it('settles cancellation ownership when reserve reentry then throws', async () => {
    let generation = undefined as InitializedHostGeneration | undefined
    let reenteredClose: Promise<unknown> | undefined
    const reserve = vi.fn(() => {
      reenteredClose = generation?.cleanup()
      if (reenteredClose === undefined) throw new Error('generation not initialized')
      void reenteredClose.catch(() => undefined)
      throw new Error('reserve failed')
    })
    generation = initialized({ reserve })

    const request = generation.request(spawn('reentry-reserve-throw' as HostRequestId))
    await expect.poll(() => reenteredClose !== undefined).toBe(true)
    const error = await closeErrorFromPromise(reenteredClose!)
    const [requestSettlement] = await Promise.allSettled([request])

    expect(requestSettlement).toBeDefined()
    expect(error.report.issues.map(closeIssueLabel)).toEqual(['reservation:reserve failed'])
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
  })

  it('does not restore same-id admission tails after close claims a reservation', async () => {
    let generation = undefined as InitializedHostGeneration | undefined
    let reenteredClose: Promise<unknown> | undefined
    let reentry: Promise<void> | undefined
    let snapshotDuringCancel: ReturnType<InitializedHostGeneration['ownershipSnapshot']> | undefined
    const cancel = vi.fn(() => {
      snapshotDuringCancel = generation?.ownershipSnapshot()
      reentry = generation?.request(spawn('same-id-reentry' as HostRequestId))
      return Promise.reject(new Error('claimed cancel failed'))
    })
    const reserve = vi.fn(() => {
      reenteredClose = generation?.cleanup()
      if (reenteredClose === undefined) throw new Error('generation not initialized')
      void reenteredClose.catch(() => undefined)
      return { id: LEASE_A, start: () => new Promise<BrokerLease>(() => {}), cancel }
    })
    generation = initialized({ reserve })

    const request = generation.request(spawn('claimed-reservation' as HostRequestId))
    await expect.poll(() => reenteredClose !== undefined).toBe(true)
    const error = await closeErrorFromPromise(reenteredClose!)
    const settlements = await Promise.allSettled([request, reentry!])

    expect(snapshotDuringCancel).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    expect(error.report.issues.map(closeIssueLabel)).toEqual(['reservation:claimed cancel failed'])
    expect(cancel).toHaveBeenCalledOnce()
    expect(settlements).toHaveLength(2)
  })

  it('detaches bounded reservation collections for repeated hanging starts', async () => {
    const generation = initialized(
      broker(() => ({ id: LEASE_A, start: () => new Promise<BrokerLease>(() => {}), cancel() {} })).value,
      { deadline: deadline(async (lane, operation) => lane.kind === 'reservation'
        ? { status: 'expired' }
        : { status: 'settled', value: await operation }) },
    )
    const requests: Promise<void>[] = []
    for (let index = 0; index < 32; index += 1) {
      requests.push(generation.request(spawn(`hang-${index}` as HostRequestId)))
    }
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(32)

    await closeError(generation)
    const settlements = await Promise.allSettled(requests)

    expect(settlements).toHaveLength(32)
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
  })

  it('starts existing close lanes before a held reservation lane settles', async () => {
    const owned = fakeLease()
    const collision = fakeLease()
    const pendingStart = controlled<BrokerLease>()
    const reservationGate = controlled<{ status: 'expired' }>()
    const hostStop = vi.fn()
    let starts = 0
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: () => {
        starts += 1
        if (starts === 1) return Promise.resolve(owned.lease)
        if (starts === 2) return Promise.resolve(collision.lease)
        return pendingStart.promise
      },
      cancel() {},
    })).value, {
      host: { stop: hostStop },
      deadline: deadline(async (lane, operation) => {
        if (lane.kind === 'reservation') return reservationGate.promise
        return { status: 'settled', value: await operation }
      }),
    })
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    collision.stopCleanup.resolve({ quiescent: true, issues: [] })
    await generation.request(spawn('existing' as HostRequestId))
    await generation.request(spawn('published-collision' as HostRequestId))
    const pendingRequest = generation.request(spawn('held-reservation' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)

    const close = generation.cleanup()
    await expect.poll(() => hostStop.mock.calls.length).toBe(1)
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(collision.stop).toHaveBeenCalledOnce()
    let closeSettled = false
    void close.catch(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)

    reservationGate.resolve({ status: 'expired' })
    await closeErrorFromPromise(close)
    const late = fakeLease('late-held' as HostLeaseId)
    late.stopCleanup.resolve({ quiescent: true, issues: [] })
    pendingStart.resolve(late.lease)
    await pendingRequest
    await expect.poll(() => late.stop.mock.calls.length).toBe(1)
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
  })

  it('transfers ownership and starts existing lanes before synchronous cancel reentry', async () => {
    const owned = fakeLease()
    const collision = fakeLease()
    owned.stopCleanup.resolve({ quiescent: true, issues: [] })
    collision.stopCleanup.resolve({ quiescent: true, issues: [] })
    const pending = controlled<BrokerLease>()
    let generation = undefined as InitializedHostGeneration | undefined
    let starts = 0
    let reentrySnapshot: ReturnType<InitializedHostGeneration['ownershipSnapshot']> | undefined
    let closeAlias: Promise<unknown> | undefined
    const hostStop = vi.fn()
    const cancel = vi.fn(() => {
      reentrySnapshot = generation?.ownershipSnapshot()
      closeAlias = generation?.cleanup()
    })
    generation = initialized(broker(() => ({
      id: LEASE_A,
      start: () => {
        starts += 1
        if (starts === 1) return Promise.resolve(owned.lease)
        if (starts === 2) return Promise.resolve(collision.lease)
        return pending.promise
      },
      cancel,
    })).value, { host: { stop: hostStop } })
    await generation.request(spawn('sync-owned' as HostRequestId))
    await generation.request(spawn('sync-collision' as HostRequestId))
    const request = generation.request(spawn('sync-pending' as HostRequestId))
    await expect.poll(() => generation?.ownershipSnapshot().reservations).toBe(1)

    const close = generation.cleanup()

    expect(closeAlias).toBe(close)
    expect(reentrySnapshot).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    expect(hostStop).toHaveBeenCalledOnce()
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(collision.stop).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    const late = fakeLease('sync-late' as HostLeaseId)
    late.stopCleanup.resolve({ quiescent: true, issues: [] })
    pending.resolve(late.lease)
    await request
    await closeErrorFromPromise(close)
  })

  it('bounds a rejected cancellation while startup hangs without callback diagnostics', async () => {
    const started = controlled<BrokerLease>()
    const observed = diagnostics()
    const cancelFailure = new Error('cancel failed')
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: () => started.promise,
      cancel: () => Promise.reject(cancelFailure),
    })).value, { diagnostics: observed.value })
    const request = generation.request(spawn('cancel-rejected' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)

    const error = await closeError(generation)
    await request

    expect(error.report.issues.map(closeIssueLabel)).toEqual(['reservation:cancel failed'])
    expect(observed.callbackFailed).not.toHaveBeenCalled()
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    started.reject(new Error('late start failed'))
    await expect.poll(() => observed.lateFailure.mock.calls.length).toBe(1)
    expect(observed.lateFailure).toHaveBeenCalledExactlyOnceWith(
      { kind: 'reservation', request: 'cancel-rejected' },
      expect.objectContaining({ message: 'late start failed' }),
    )
  })

  it('bounds hanging cancellation and startup, then cleans a late lease once', async () => {
    const started = controlled<BrokerLease>()
    const cancelSettlement = controlled<undefined>()
    const cancel = vi.fn(() => cancelSettlement.promise)
    const late = fakeLease('late-cancelled' as HostLeaseId)
    late.stopCleanup.resolve({ quiescent: true, issues: [] })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: () => started.promise, cancel })).value, {
      deadline: deadline(async (lane, operation) => lane.kind === 'reservation'
        ? { status: 'expired' }
        : { status: 'settled', value: await operation }),
    })
    const request = generation.request(spawn('cancel-hang' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)

    const close = generation.cleanup()
    expect(generation.disconnect()).toBe(close)
    await closeErrorFromPromise(close)
    expect(cancel).toHaveBeenCalledOnce()
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })

    started.resolve(late.lease)
    cancelSettlement.resolve(undefined)
    await request
    await expect.poll(() => late.stop.mock.calls.length).toBe(1)
  })

  it('keeps prompt reservation settlement in the close cleanup barrier', async () => {
    const started = controlled<BrokerLease>()
    const leaseCleanup = controlled<Awaited<ReturnType<BrokerLease['stop']>>>()
    const owned: BrokerLease = {
      id: 'during-close' as HostLeaseId,
      exited: new Promise<void>(() => {}),
      stop: vi.fn(() => leaseCleanup.promise),
    }
    const generation = initialized(broker(() => ({ id: owned.id, start: () => started.promise, cancel() {} })).value)
    const request = generation.request(spawn())
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)
    const close = generation.cleanup()
    started.resolve(owned)
    await request
    let settled = false
    void close.finally(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    leaseCleanup.resolve({ quiescent: true, issues: [] })
    await close
  })

  it('uses a collision lane for a prompt close-time duplicate reservation', async () => {
    const original = fakeLease()
    const duplicateCleanup = controlled<Awaited<ReturnType<BrokerLease['stop']>>>()
    const duplicateStop = vi.fn(() => duplicateCleanup.promise)
    const duplicate: BrokerLease = {
      id: LEASE_A,
      exited: new Promise<void>(() => {}),
      stop: duplicateStop,
    }
    original.stopCleanup.resolve({
      quiescent: false,
      issues: [{ phase: 'final', code: 'final-failed', message: 'owned cleanup issue' }],
    })
    const pending = controlled<BrokerLease>()
    let starts = 0
    const lanes: HostGenerationLane[] = []
    const bounded = deadline(async (lane, operation) => {
      lanes.push(lane)
      return { status: 'settled', value: await operation }
    })
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: () => ++starts === 1 ? Promise.resolve(original.lease) : pending.promise,
      cancel() {},
    })).value, { deadline: bounded })
    await generation.request(spawn('owned' as HostRequestId))
    const request = generation.request(spawn('close-duplicate' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)
    const close = generation.cleanup()
    pending.resolve(duplicate)
    await request
    let closeSettled = false
    void close.catch(() => { closeSettled = true })
    await Promise.resolve()

    expect(closeSettled).toBe(false)
    expect(generation.ownershipSnapshot()).toEqual({ reservations: 0, leases: 0, collisions: 0, admissionTails: 0 })
    await expect.poll(() => lanes.filter(lane => lane.kind === 'collision').length).toBe(1)
    expect(lanes.filter(lane => lane.kind === 'collision')).toEqual([
      { kind: 'collision', request: 'close-duplicate', lease: LEASE_A },
    ])
    expect(lanes.filter(lane => lane.kind === 'lease' && lane.lease === LEASE_A)).toHaveLength(1)
    duplicateCleanup.resolve({
      quiescent: false,
      issues: [{ phase: 'final', code: 'final-failed', message: 'duplicate cleanup issue' }],
    })
    const error = await closeErrorFromPromise(close)
    expect(error.report.issues.map(closeIssueLabel)).toEqual([
      'collision:close-duplicate',
      'lease:duplicate cleanup issue',
      'lease:broker lease did not reach verified quiescence',
      'lease:owned cleanup issue',
      'lease:broker lease did not reach verified quiescence',
    ])
    expect(original.stop).toHaveBeenCalledOnce()
    expect(duplicateStop).toHaveBeenCalledOnce()
  })

  it('does not head-of-line block a prompt different-id reservation', async () => {
    const hanging = controlled<BrokerLease>()
    const leaseB = fakeLease('lease-b' as HostLeaseId)
    leaseB.stopCleanup.resolve({ quiescent: true, issues: [] })
    let reservations = 0
    const output = channel()
    const generation = initialized(broker(() => {
      reservations += 1
      return reservations === 1
        ? { id: LEASE_A, start: () => hanging.promise, cancel() {} }
        : { id: leaseB.lease.id, start: () => Promise.resolve(leaseB.lease), cancel() {} }
    }).value, { channel: output.value })
    const first = generation.request(spawn('hung-a' as HostRequestId))
    const second = generation.request(spawn('prompt-b' as HostRequestId))

    await second

    expect(output.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawned', request: 'prompt-b', lease: 'lease-b',
    }))
    const close = generation.cleanup()
    const lateA = fakeLease()
    lateA.stopCleanup.resolve({ quiescent: true, issues: [] })
    hanging.resolve(lateA.lease)
    await first
    await close
  })

  it('fails closed and cleans a lease whose id mismatches its reservation', async () => {
    const mismatch = fakeLease('mismatch' as HostLeaseId)
    mismatch.stopCleanup.resolve({ quiescent: true, issues: [] })
    const output = channel()
    const generation = initialized(broker(() => ({
      id: LEASE_A,
      start: () => Promise.resolve(mismatch.lease),
      cancel() {},
    })).value, { channel: output.value })

    await generation.request(spawn('mismatch-request' as HostRequestId))

    expect(output.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawn-rejected', request: 'mismatch-request',
    }))
    await expect.poll(() => mismatch.stop.mock.calls.length).toBe(1)
    expect(generation.ownershipSnapshot().leases).toBe(0)
  })

  it('classifies concurrent same-id reservations by admission order', async () => {
    const firstStart = controlled<BrokerLease>()
    const secondStart = controlled<BrokerLease>()
    const firstLease = fakeLease('shared' as HostLeaseId)
    const secondLease = fakeLease('shared' as HostLeaseId)
    firstLease.stopCleanup.resolve({
      quiescent: true,
      issues: [{ phase: 'final', code: 'final-failed', message: 'first cleanup' }],
    })
    secondLease.stopCleanup.resolve({
      quiescent: true,
      issues: [{ phase: 'final', code: 'final-failed', message: 'second cleanup' }],
    })
    let starts = 0
    const lanes: HostGenerationLane[] = []
    const generation = initialized(broker(() => ({
      id: firstLease.lease.id,
      start: () => ++starts === 1 ? firstStart.promise : secondStart.promise,
      cancel() {},
    })).value, {
      deadline: deadline(async (lane, operation) => {
        lanes.push(lane)
        return { status: 'settled', value: await operation }
      }),
    })
    const firstRequest = generation.request(spawn('admitted-a' as HostRequestId))
    const secondRequest = generation.request(spawn('admitted-b' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(2)
    const close = generation.cleanup()

    secondStart.resolve(secondLease.lease)
    firstStart.resolve(firstLease.lease)
    await Promise.all([firstRequest, secondRequest])
    const error = await closeErrorFromPromise(close)

    expect(lanes.filter(lane => lane.kind === 'lease')).toEqual([{ kind: 'lease', lease: 'shared' }])
    expect(lanes.filter(lane => lane.kind === 'collision')).toEqual([
      { kind: 'collision', request: 'admitted-b', lease: 'shared' },
    ])
    expect(error.report.issues.map(closeIssueLabel)).toEqual([
      'collision:admitted-b',
      'lease:first cleanup',
      'lease:second cleanup',
    ])
    expect(firstLease.stop).toHaveBeenCalledOnce()
    expect(secondLease.stop).toHaveBeenCalledOnce()
  })

  it('does not cancel an already-started reservation waiting on admission order', async () => {
    const firstStart = controlled<BrokerLease>()
    const firstLease = fakeLease('prior' as HostLeaseId)
    const secondLease = fakeLease('already-started' as HostLeaseId)
    firstLease.stopCleanup.resolve({ quiescent: true, issues: [] })
    secondLease.stopCleanup.resolve({ quiescent: true, issues: [] })
    const secondCancel = vi.fn(() => new Promise<void>(() => {}))
    let reservations = 0
    const generation = initialized(broker(() => {
      reservations += 1
      return reservations === 1
        ? { id: firstLease.lease.id, start: () => firstStart.promise, cancel() {} }
        : { id: secondLease.lease.id, start: () => Promise.resolve(secondLease.lease), cancel: secondCancel }
    }).value)
    const firstRequest = generation.request(spawn('prior-request' as HostRequestId))
    const secondRequest = generation.request(spawn('started-request' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(2)
    await Promise.resolve()

    const close = generation.cleanup()
    firstStart.resolve(firstLease.lease)
    await Promise.all([firstRequest, secondRequest])
    await close

    expect(secondCancel).not.toHaveBeenCalled()
    expect(firstLease.stop).toHaveBeenCalledOnce()
    expect(secondLease.stop).toHaveBeenCalledOnce()
  })

  it('classifies open concurrent same-id reservations by admission order', async () => {
    const firstStart = controlled<BrokerLease>()
    const secondStart = controlled<BrokerLease>()
    const firstLease = fakeLease('open-shared' as HostLeaseId)
    const secondLease = fakeLease('open-shared' as HostLeaseId)
    firstLease.stopCleanup.resolve({ quiescent: true, issues: [] })
    secondLease.stopCleanup.resolve({ quiescent: true, issues: [] })
    let starts = 0
    const output = channel()
    const generation = initialized(broker(() => ({
      id: firstLease.lease.id,
      start: () => ++starts === 1 ? firstStart.promise : secondStart.promise,
      cancel() {},
    })).value, { channel: output.value })
    const firstRequest = generation.request(spawn('open-a' as HostRequestId))
    const secondRequest = generation.request(spawn('open-b' as HostRequestId))
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(2)

    secondStart.resolve(secondLease.lease)
    let secondSettled = false
    void secondRequest.then(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    firstStart.resolve(firstLease.lease)
    await Promise.all([firstRequest, secondRequest])

    expect(output.emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'spawned', request: 'open-a', lease: 'open-shared',
    }))
    expect(output.emit).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: 'spawn-rejected', request: 'open-b',
    }))
    expect(firstLease.stop).not.toHaveBeenCalled()
    expect(secondLease.stop).toHaveBeenCalledOnce()
    await closeError(generation)
    expect(firstLease.stop).toHaveBeenCalledOnce()
  })

  it('bounds a correlated stop request and diagnoses its late rejection', async () => {
    const owned = fakeLease()
    const observed = diagnostics()
    const lanes: HostGenerationLane[] = []
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value, {
      diagnostics: observed.value,
      deadline: deadline(async (lane, operation) => {
        lanes.push(lane)
        return lane.kind === 'lease' ? { status: 'expired' } : { status: 'settled', value: await operation }
      }),
    })
    await generation.request(spawn())

    await expect(generation.request(stop())).rejects.toThrow(/cleanup expired/)
    expect(lanes).toContainEqual({ kind: 'lease', lease: LEASE_A })
    owned.stopCleanup.reject(new Error('late stop failure'))
    await expect.poll(() => observed.lateFailure.mock.calls.length).toBe(1)
    expect(owned.stop).toHaveBeenCalledOnce()
  })

  it('sorts lease issues stably by cleanup phase', async () => {
    const owned = fakeLease()
    owned.stopCleanup.resolve({
      quiescent: false,
      issues: [
        { phase: 'final', code: 'final-failed', message: 'final-1' },
        { phase: 'graceful', code: 'graceful-failed', message: 'graceful' },
        { phase: 'final', code: 'final-failed', message: 'final-2' },
        { phase: 'settle', code: 'settle-failed', message: 'settle' },
        { phase: 'force', code: 'force-failed', message: 'force' },
      ],
    })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned.lease, cancel() {} })).value)
    await generation.request(spawn())

    const error = await closeError(generation)
    expect(error.report.issues.map(issue => issue.kind === 'lease' ? issue.issue.message : issue.message)).toEqual([
      'graceful', 'settle', 'force', 'final-1', 'final-2', 'broker lease did not reach verified quiescence',
    ])
  })

  it('does not diagnose the exact prompt rejection surfaced by deadline', async () => {
    const observed = diagnostics()
    const prompt = new Error('prompt lease failure')
    const owned: BrokerLease = {
      id: LEASE_A,
      exited: new Promise<void>(() => {}),
      stop: () => Promise.reject(prompt),
    }
    const surfacedDeadline = deadline(async (_lane, operation) => {
      try {
        return { status: 'settled', value: await operation }
      } catch (error) {
        throw error
      }
    })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: async () => owned, cancel() {} })).value, {
      deadline: surfacedDeadline,
      diagnostics: observed.value,
    })
    await generation.request(spawn())

    const error = await closeError(generation)

    expect(error.report.issues).toContainEqual({
      kind: 'lease', lease: LEASE_A,
      issue: { phase: 'final', code: 'final-failed', message: 'prompt lease failure' },
    })
    expect(observed.lateFailure).not.toHaveBeenCalled()
  })

  it('reports a late detached cleanup issue exactly once', async () => {
    const observed = diagnostics()
    const started = controlled<BrokerLease>()
    const lateIssueObserved = controlled<undefined>()
    const lateCleanupIssue = vi.fn(() => { lateIssueObserved.resolve(undefined) })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: () => started.promise, cancel() {} })).value, {
      diagnostics: { ...observed.value, lateCleanupIssue },
      deadline: deadline(async (lane, operation) => lane.kind === 'reservation'
        ? { status: 'expired' }
        : { status: 'settled', value: await operation }),
    })
    const request = generation.request(spawn())
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)
    await closeError(generation)
    const late = fakeLease('late' as HostLeaseId)
    late.stopCleanup.resolve({ quiescent: false, issues: [] })

    started.resolve(late.lease)
    await request
    await lateIssueObserved.promise

    expect(lateCleanupIssue).toHaveBeenCalledExactlyOnceWith(
      { kind: 'lease', lease: 'late' },
      { phase: 'final', code: 'fixture-not-quiescent', message: 'broker lease did not reach verified quiescence' },
    )
  })

  it('reports a late detached cleanup expiry exactly once', async () => {
    const observed = diagnostics()
    const started = controlled<BrokerLease>()
    const leaseLanes: string[] = []
    const lateIssueObserved = controlled<undefined>()
    const lateCleanupIssue = vi.fn(() => { lateIssueObserved.resolve(undefined) })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: () => started.promise, cancel() {} })).value, {
      diagnostics: { ...observed.value, lateCleanupIssue },
      deadline: deadline(async (lane, operation) => {
        if (lane.kind === 'reservation') return { status: 'expired' }
        if (lane.kind === 'lease') {
          leaseLanes.push(lane.lease)
          return { status: 'expired' }
        }
        return { status: 'settled', value: await operation }
      }),
    })
    const request = generation.request(spawn())
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)
    await closeError(generation)
    const late = fakeLease('late-expired' as HostLeaseId)
    started.resolve(late.lease)
    await request
    await lateIssueObserved.promise

    expect(leaseLanes).toEqual(['late-expired'])
    expect(lateCleanupIssue).toHaveBeenCalledExactlyOnceWith(
      { kind: 'lease', lease: 'late-expired' },
      { phase: 'final', code: 'final-failed', message: 'lease cleanup expired' },
    )
  })

  it('contains emits and reports distinct late failures exactly once', async () => {
    const observed = diagnostics()
    const started = controlled<BrokerLease>()
    const output: HostGenerationChannel = { emit() { throw new Error('emit failed') } }
    const bounded = deadline(async () => { throw new Error('deadline failed') })
    const lateFailureObserved = controlled<undefined>()
    const lateFailure = vi.fn(() => { lateFailureObserved.resolve(undefined) })
    const generation = initialized(broker(() => ({ id: LEASE_A, start: () => started.promise, cancel() {} })).value, {
      channel: output, deadline: bounded, diagnostics: { ...observed.value, lateFailure },
    })
    const request = generation.request(spawn())
    await expect.poll(() => generation.ownershipSnapshot().reservations).toBe(1)

    await closeError(generation)
    started.reject(new Error('late start failed'))
    await request
    await lateFailureObserved.promise
    expect(observed.callbackFailed).toHaveBeenCalledWith(expect.objectContaining({ message: 'emit failed' }))
    expect(lateFailure).toHaveBeenCalledExactlyOnceWith(
      { kind: 'reservation', request: SPAWN_A }, expect.objectContaining({ message: 'late start failed' }),
    )
  })
})
