import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PhoneIoTransports, type PhoneIoServer, type TransportScope } from '../src/phone-io-transports.ts'

class FakeSocket extends EventEmitter { readonly destroy = vi.fn(() => { this.emit('close') }) }
class FakePeer extends EventEmitter { readonly close = vi.fn(() => { this.emit('close') }) }
function harness() {
  let ready: ((peer: FakePeer) => void) | undefined
  let closeDone: ((error?: Error) => void) | undefined
  const upgradeMock: PhoneIoServer['handleUpgrade'] = vi.fn((_req, _socket, _head, callback) => { ready = callback as never })
  const closeMock = vi.fn((callback: (error?: Error) => void) => { closeDone = callback })
  const server: PhoneIoServer = { handleUpgrade: upgradeMock, close: closeMock }
  const failures = vi.fn(); const timeouts = vi.fn(); const reject = vi.fn((socket: FakeSocket) => { socket.destroy() })
  const deadlines = new Map<string, { expire(): void; reject(error: unknown): void }>()
  const keyOf = (scope: TransportScope): string => scope.subsystem === 'server' ? 'server' : `connection:${String(scope.sequence)}`
  const owner = new PhoneIoTransports(server, { reject: reject as never }, async (task, scope) => {
    const key = keyOf(scope)
    return await Promise.race([
      task.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve, rejectDeadline) => { deadlines.set(key, { expire: () => { resolve('timeout') }, reject: rejectDeadline }) }),
    ]).finally(() => { deadlines.delete(key) })
  }, { failure: failures, timeout: timeouts })
  return {
    owner, server, closeMock, upgradeMock, failures, timeouts, reject, deadlines,
    open: (peer: FakePeer) => { ready?.(peer) },
    closeServer: (error?: Error) => { closeDone?.(error) },
    expire: (scope: TransportScope) => { deadlines.get(keyOf(scope))?.expire() },
    rejectDeadline: (scope: TransportScope, error: unknown) => { deadlines.get(keyOf(scope))?.reject(error) },
  }
}
const request = {} as never
const head = Buffer.alloc(0)

describe('PhoneIoTransports', () => {
  it('publishes a dispatch task before synchronous reentrant close', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); let release!: () => void
    let close!: Promise<void>
    h.owner.accept(request, socket as never, head, async () => {
      close = h.owner.close(new Error('stop'))
      await new Promise<void>((resolve) => { release = resolve })
    })
    h.open(peer); peer.emit('message', 'x'); h.closeServer()
    let settled = false; void close.then(() => { settled = true }); await Promise.resolve(); expect(settled).toBe(false)
    release(); await close
  })

  it('publishes connection stop before peer close reenters owner close', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); let nested!: Promise<void>
    h.owner.accept(request, socket as never, head, async () => {}); h.open(peer)
    peer.close.mockImplementationOnce(() => { nested = h.owner.close(new Error('nested')) })
    peer.emit('close')
    h.closeServer()
    await nested
    expect(peer.close).toHaveBeenCalledOnce()
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(h.closeMock).toHaveBeenCalledOnce()
  })

  it('memoizes close before synchronous server reentry', async () => {
    const h = harness(); let nested!: Promise<void>
    vi.mocked(h.closeMock).mockImplementationOnce((done) => { nested = h.owner.close(new Error('nested')); done() })
    const first = h.owner.close(new Error('stop')); expect(nested).toBe(first); await Promise.all([first, nested])
    expect(h.closeMock).toHaveBeenCalledOnce()
  })

  it('aggregates WSS callback error before a synchronous post-callback throw', async () => {
    const h = harness(); const callbackFailure = new Error('callback'); const throwFailure = new Error('throw')
    vi.mocked(h.closeMock).mockImplementationOnce((done) => { done(callbackFailure); throw throwFailure })
    const close = h.owner.close(new Error('stop'))
    await expect(close).rejects.toMatchObject({ errors: [callbackFailure, throwFailure] })
    expect(h.failures.mock.calls).toEqual([[{ subsystem: 'server' }, callbackFailure], [{ subsystem: 'server' }, throwFailure]])
  })

  it.each(['server', 'connection'] as const)('retains a %s tombstone after deadline rejection', async (subsystem) => {
    const h = harness(); const deadlineFailure = new Error(`${subsystem} deadline`)
    let release!: () => void
    if (subsystem === 'connection') {
      const socket = new FakeSocket(); const peer = new FakePeer()
      h.owner.accept(request, socket as never, head, async () =>{  await new Promise<void>((resolve) => { release = resolve }) })
      h.open(peer); peer.emit('message', 'x'); h.closeServer()
    }
    const close = h.owner.close(new Error('stop'))
    if (subsystem === 'connection') h.closeServer()
    h.rejectDeadline(subsystem === 'server' ? { subsystem: 'server' } : { subsystem: 'connection', sequence: 1 }, deadlineFailure)
    await expect(close).rejects.toBe(deadlineFailure)
    expect(h.failures).toHaveBeenCalledTimes(1)
    expect(h.failures).toHaveBeenCalledWith(subsystem === 'server' ? { subsystem: 'server' } : { subsystem: 'connection', sequence: 1 }, deadlineFailure)
    expect(h.owner.ownershipSnapshot()[subsystem === 'server' ? 'serverTombstones' : 'connections']).toBe(1)
    if (subsystem === 'server') h.closeServer(); else release()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 0, tasks: 0, serverTombstones: 0 })
  })

  it('aggregates server then connection and task failures in stable order', async () => {
    const h = harness(); const serverFailure = new Error('server'); const peerFailure = new Error('peer close')
    const taskOne = new Error('task one'); const taskTwo = new Error('task two')
    const socket = new FakeSocket(); const peer = new FakePeer(); peer.close.mockImplementationOnce(() => { throw peerFailure })
    const rejects: Array<(error: unknown) => void> = []
    h.owner.accept(request, socket as never, head, async () => await new Promise<never>((_resolve, reject) => { rejects.push(reject) })); h.open(peer); peer.emit('message', '1'); peer.emit('message', '2')
    const close = h.owner.close(new Error('stop')); h.closeServer(serverFailure); rejects[1]?.(taskTwo); rejects[0]?.(taskOne)
    await expect(close).rejects.toMatchObject({ errors: [serverFailure, peerFailure, taskOne, taskTwo] })
  })

  it('flattens only owned aggregates in server and connection structural order', async () => {
    const h = harness(); const serverOne = new Error('server callback'); const serverTwo = new Error('server throw')
    const closeFailures = [new Error('connection one'), new Error('connection two')]
    const userAggregate = new AggregateError([new Error('user inner')], 'user payload')
    const peers = [new FakePeer(), new FakePeer()]
    const taskRejects: Array<(error: unknown) => void> = []
    for (const [index, peer] of peers.entries()) {
      const socket = new FakeSocket(); peer.close.mockImplementationOnce(() => { throw closeFailures[index] })
      h.owner.accept(request, socket as never, head, async () => await new Promise<never>((_resolve, reject) => { taskRejects.push(reject) })); h.open(peer); peer.emit('message', 'x')
    }
    vi.mocked(h.closeMock).mockImplementationOnce((done) => { done(serverOne); throw serverTwo })
    const close = h.owner.close(new Error('stop'))
    taskRejects[1]?.(userAggregate); taskRejects[0]?.(new Error('task one'))
    let caught: unknown
    try { await close } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    const errors = (caught as AggregateError).errors
    expect(errors[0]).toBe(serverOne); expect(errors[1]).toBe(serverTwo); expect(errors[2]).toBe(closeFailures[0])
    expect(errors[3]).toMatchObject({ message: 'task one' }); expect(errors[4]).toBe(closeFailures[1])
    expect(errors[5]).toBe(userAggregate)
  })

  it('contains a synchronous raw close during upgrade without TDZ', async () => {
    const h = harness(); const socket = new FakeSocket()
    vi.mocked(h.upgradeMock).mockImplementationOnce((_req, raw) => { raw.emit('close') })
    expect(() => { h.owner.accept(request, socket as never, head, async () => {}) }).not.toThrow()
    expect(socket.listenerCount('close')).toBe(0)
    const close = h.owner.close(new Error('stop')); h.closeServer(); await close
  })

  it('joins cooperative dispatch after peer close', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer()
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
    const dispatch = vi.fn(async () => { await gate })
    expect(h.owner.accept(request, socket as never, head, dispatch)).toBe(true)
    h.open(peer); peer.emit('message', 'x'); peer.emit('close')
    const close = h.owner.close(new Error('stop')); h.closeServer(); release(); await close
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('bounds stubborn dispatch and reports its connection scope', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer()
    h.owner.accept(request, socket as never, head, async () =>{  await new Promise(() => {}) }); h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(new Error('stop')); h.closeServer(); h.expire({ subsystem: 'connection', sequence: 1 })
    await expect(close).rejects.toThrow('connection transport cleanup timed out')
    expect(h.timeouts).toHaveBeenCalledWith({ subsystem: 'connection', sequence: 1 })
  })

  it.each(['success', 'error', 'hang'] as const)('owns WSS close %s', async (outcome) => {
    const h = harness(); const close = h.owner.close(new Error('stop'))
    if (outcome === 'success') h.closeServer()
    if (outcome === 'error') h.closeServer(new Error('wss failed'))
    if (outcome === 'hang') h.expire({ subsystem: 'server' })
    if (outcome === 'success') await close
    else await expect(close).rejects.toThrow(outcome === 'error' ? 'wss failed' : 'server transport cleanup timed out')
  })

  it('closes a late peer after raw close without listeners', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer()
    h.owner.accept(request, socket as never, head, async () => {}); socket.emit('close'); h.open(peer)
    expect(peer.close).toHaveBeenCalledOnce(); expect(peer.listenerCount('message')).toBe(0)
    const close = h.owner.close(new Error('stop')); h.closeServer(); await close
  })

  it('closes the full transport after a fatal dispatch defect without retaining terminal ownership', async () => {
    const h = harness(); const firstSocket = new FakeSocket(); const firstPeer = new FakePeer()
    const secondSocket = new FakeSocket(); const secondPeer = new FakePeer(); const failure = new Error('defect')
    h.owner.accept(request, firstSocket as never, head, async () => { throw failure }); h.open(firstPeer)
    h.owner.accept(request, secondSocket as never, head, async () => {}); h.open(secondPeer)
    firstPeer.emit('message', 'one')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(firstPeer.listenerCount('message')).toBe(0); expect(secondPeer.listenerCount('message')).toBe(0)
    secondPeer.emit('message', 'later')
    expect(h.owner.ownershipSnapshot().tasks).toBe(0)
    h.closeServer()
    const close = h.owner.close(new Error('global')); await expect(close).rejects.toBe(failure)
    expect(h.failures).toHaveBeenCalledTimes(1)
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 0, tasks: 0, serverTombstones: 0 })
  })

  it('stops a connection after a dispatch defect instead of retaining failed tasks', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); const failure = new Error('defect')
    h.owner.accept(request, socket as never, head, async () => { throw failure }); h.open(peer)
    peer.emit('message', 'one')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    peer.emit('message', 'two')
    expect(h.owner.ownershipSnapshot().tasks).toBe(0)
    expect(peer.listenerCount('message')).toBe(0)
    const close = h.owner.close(new Error('global')); h.closeServer(); await expect(close).rejects.toBe(failure)
  })

  it.each(['sync', 'async'] as const)('reports a %s dispatcher defect exactly once', async (kind) => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); const failure = new Error(`${kind} defect`)
    const dispatch = kind === 'sync' ? (() => { throw failure }) : (async () => { throw failure })
    h.owner.accept(request, socket as never, head, dispatch); h.open(peer); peer.emit('message', 'x')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.failures).toHaveBeenCalledTimes(1); expect(h.failures).toHaveBeenCalledWith({ subsystem: 'connection', sequence: 1 }, failure)
    const close = h.owner.close(new Error('stop')); h.closeServer(); await expect(close).rejects.toBe(failure)
    expect(h.failures).toHaveBeenCalledTimes(1)
  })

  it.each(['before-close', 'during-stop'] as const)('retains the same defect when it settles %s', async (timing) => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); const failure = new Error('defect')
    let rejectTask!: (error: unknown) => void
    h.owner.accept(request, socket as never, head, async () => await new Promise<never>((_resolve, reject) => { rejectTask = reject }))
    h.open(peer); peer.emit('message', 'x')
    if (timing === 'before-close') { rejectTask(failure); await new Promise<void>((resolve) => { setImmediate(resolve) }) }
    const close = h.owner.close(new Error('stop')); h.closeServer()
    if (timing === 'during-stop') rejectTask(failure)
    await expect(close).rejects.toBe(failure)
    expect(h.failures).toHaveBeenCalledTimes(1)
  })

  it('aborts and removes listeners synchronously before joining cooperative dispatch', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); let seenSignal: AbortSignal | undefined
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
    h.owner.accept(request, socket as never, head, async (_peer, _raw, signal) => { seenSignal = signal; await gate })
    h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(new Error('stop'))
    expect(seenSignal?.aborted).toBe(true); expect(socket.listenerCount('close')).toBe(0)
    expect(peer.listenerCount('message')).toBe(0); expect(peer.listenerCount('close')).toBe(0)
    let settled = false; void close.then(() => { settled = true }); await Promise.resolve(); expect(settled).toBe(false)
    h.closeServer(); release(); await close
  })

  it('treats the exact stop reason as inert but returns one distinct stopping failure', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); const stopReason = new Error('stop')
    let rejectTask!: (error: unknown) => void
    const gate = new Promise<never>((_resolve, reject) => { rejectTask = reject })
    h.owner.accept(request, socket as never, head, async () => await gate); h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(stopReason); h.closeServer(); rejectTask(stopReason); await close
    expect(h.failures).not.toHaveBeenCalled()

    const second = harness(); const socket2 = new FakeSocket(); const peer2 = new FakePeer(); const distinct = new Error('late defect')
    let rejectSecond!: (error: unknown) => void
    second.owner.accept(
      request,
      socket2 as never,
      head,
      async () => await new Promise<never>((_resolve, reject) => { rejectSecond = reject }),
    )
    second.open(peer2); peer2.emit('message', 'x')
    const close2 = second.owner.close(stopReason); second.closeServer(); rejectSecond(distinct)
    await expect(close2).rejects.toBe(distinct)
    expect(second.failures).toHaveBeenCalledTimes(1)
  })

  it('tracks independent server and connection deadline scopes', async () => {
    const h = harness(); const peers = [new FakePeer(), new FakePeer()]
    for (const peer of peers) { const socket = new FakeSocket()
      h.owner.accept(request, socket as never, head, async () =>{  await new Promise(() => {}) }); h.open(peer); peer.emit('message', 'x') }
    const close = h.owner.close(new Error('stop'))
    await Promise.resolve()
    expect([...h.deadlines.keys()].sort()).toEqual(['connection:1', 'connection:2', 'server'])
    h.expire({ subsystem: 'server' }); h.expire({ subsystem: 'connection', sequence: 1 })
    h.expire({ subsystem: 'connection', sequence: 2 })
    await expect(close).rejects.toBeInstanceOf(AggregateError)
    expect(h.deadlines.size).toBe(0)
  })

  it('keeps WSS failure first while still joining a cooperative connection', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); let release!: () => void
    h.owner.accept(request, socket as never, head, async () =>{  await new Promise<void>((resolve) => { release = resolve }) })
    h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(new Error('stop')); const failure = new Error('wss failed'); h.closeServer(failure)
    let settled = false; void close.then(() => { settled = true }, () => { settled = true }); await Promise.resolve()
    expect(settled).toBe(false)
    release(); await expect(close).rejects.toBe(failure)
  })

  it('retains a timed-out connection tombstone until a late task settles', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); const failure = new Error('late defect')
    let rejectTask!: (error: unknown) => void
    h.owner.accept(request, socket as never, head, async () => await new Promise<never>((_resolve, reject) => { rejectTask = reject })); h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(new Error('stop')); h.closeServer(); h.expire({ subsystem: 'connection', sequence: 1 })
    await expect(close).rejects.toThrow('connection transport cleanup timed out')
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 1, tasks: 1, serverTombstones: 0 })
    rejectTask(failure); await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.failures).toHaveBeenCalledTimes(1)
    expect(h.failures).toHaveBeenCalledWith({ subsystem: 'connection', sequence: 1 }, failure)
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 0, tasks: 0, serverTombstones: 0 })
  })

  it('retains a timed-out server tombstone until its late callback error', async () => {
    const h = harness(); const failure = new Error('late wss failure'); const close = h.owner.close(new Error('stop'))
    h.expire({ subsystem: 'server' }); await expect(close).rejects.toThrow('server transport cleanup timed out')
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 0, tasks: 0, serverTombstones: 1 })
    h.closeServer(failure); await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.failures).toHaveBeenCalledTimes(1)
    expect(h.failures).toHaveBeenCalledWith({ subsystem: 'server' }, failure)
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 0, tasks: 0, serverTombstones: 0 })
  })

  it('removes timeout tombstones after late cooperative success without diagnostics', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); let release!: () => void
    h.owner.accept(request, socket as never, head, async () =>{  await new Promise<void>((resolve) => { release = resolve }) })
    h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(new Error('stop')); h.expire({ subsystem: 'server' }); h.expire({ subsystem: 'connection', sequence: 1 })
    await expect(close).rejects.toBeInstanceOf(AggregateError)
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 1, tasks: 1, serverTombstones: 1 })
    release(); h.closeServer(); await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.owner.ownershipSnapshot()).toEqual({ connections: 0, tasks: 0, serverTombstones: 0 })
    expect(h.failures).not.toHaveBeenCalled()
  })

  it('memoizes close and rejects post-close without new server work', async () => {
    const h = harness(); const close1 = h.owner.close(new Error('stop')); const close2 = h.owner.close(new Error('again'))
    expect(close2).toBe(close1)
    expect(h.closeMock).toHaveBeenCalledOnce(); h.closeServer(); await Promise.all([close1, close2])
    const socket = new FakeSocket(); expect(h.owner.accept(request, socket as never, head, async () => {})).toBe(false)
    expect(h.upgradeMock).not.toHaveBeenCalled(); expect(h.reject).toHaveBeenCalledOnce()
  })

  it('treats normalized PHONE_ABORTED as cooperative cancellation', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer(); let rejectTask!: (error: unknown) => void
    h.owner.accept(request, socket as never, head, async () => await new Promise<never>((_resolve, reject) => { rejectTask = reject })); h.open(peer); peer.emit('message', 'x')
    const close = h.owner.close(new Error('stop')); h.closeServer()
    rejectTask(Object.assign(new Error('normalized'), { code: 'PHONE_ABORTED' })); await close
    expect(h.failures).not.toHaveBeenCalled()
  })

  it('contains adapter rejection failure with raw destroy fallback', async () => {
    const h = harness(); const close = h.owner.close(new Error('stop')); h.closeServer(); await close
    const socket = new FakeSocket(); h.reject.mockImplementationOnce(() => { throw new Error('reject failed') })
    expect(() => h.owner.accept(request, socket as never, head, async () => {})).not.toThrow()
    expect(socket.destroy).toHaveBeenCalledOnce(); expect(h.failures).toHaveBeenCalledOnce()
  })

  it('uses normal stop when upgrade callback is followed by throw', async () => {
    const h = harness(); const socket = new FakeSocket(); const peer = new FakePeer()
    vi.mocked(h.upgradeMock).mockImplementationOnce((_req, _raw, _head, ready) => { ready(peer as never)
      throw new Error('after ready') })
    expect(h.owner.accept(request, socket as never, head, async () => {})).toBe(false)
    expect(peer.close).toHaveBeenCalledOnce(); expect(peer.listenerCount('message')).toBe(0)
    const close = h.owner.close(new Error('stop')); h.closeServer(); await close
    expect(h.failures).toHaveBeenCalledWith({ subsystem: 'connection', sequence: 1 }, expect.objectContaining({ message: 'after ready' }))
  })

  it('memoizes a rejected close outcome without starting new work', async () => {
    const h = harness(); const failure = new Error('server failed'); const first = h.owner.close(new Error('stop')); h.closeServer(failure)
    await expect(first).rejects.toBe(failure)
    const second = h.owner.close(new Error('again'))
    expect(second).toBe(first)
    await expect(second).rejects.toBe(failure)
    expect(h.closeMock).toHaveBeenCalledOnce()
  })

  it('contains upgrade and dispatcher defects and rejects post-close', async () => {
    const h = harness(); const socket = new FakeSocket()
    vi.mocked(h.upgradeMock).mockImplementationOnce(() => { throw new Error('upgrade failed') })
    expect(h.owner.accept(request, socket as never, head, async () => {})).toBe(false)
    expect(h.reject).toHaveBeenCalledOnce()
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.failures).toHaveBeenCalledTimes(1)
    const close = h.owner.close(new Error('stop')); h.closeServer(); await close
    expect(h.owner.accept(request, new FakeSocket() as never, head, async () => {})).toBe(false)
  })
})
