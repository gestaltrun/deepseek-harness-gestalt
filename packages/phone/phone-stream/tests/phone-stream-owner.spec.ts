import { describe, expect, it, vi } from 'vitest'
import { PhoneHttpTransactions } from '../src/phone-http-transactions.ts'
import { PhoneStreamOwner } from '../src/phone-stream-owner.ts'

function gate() { let resolve!: () => void; return { promise: new Promise<void>((r) => { resolve = r }), resolve } }
function harness(count = 5) {
  const fiber = { uid: 1 as unknown }; let listener!: (fiber: { uid: unknown }) => void
  const order: string[] = []; const fence = vi.fn(); const transport = gate(); const relay = gate()
  const registrations = Array.from({ length: count }, (_, index) => () => { order.push(`register:${index}`)
    return () => { order.push(`dispose:${index}`) } })
  const owner = new PhoneStreamOwner(fiber, (callback) => { listener = callback; order.push('register:listener')
    return () => { order.push('dispose:listener') } }, registrations, fence, { http: async () => {}, transport: vi.fn(async () => { await transport.promise }), relay: vi.fn(async () => { await relay.promise }) })
  return { owner, fiber, listener, order, fence, transport, relay }
}

describe('PhoneStreamOwner', () => {
  it('fences only exact terminal owner fiber in the same call stack', () => {
    const h = harness(); h.listener({ uid: null }); h.listener(h.fiber); expect(h.fence).not.toHaveBeenCalled()
    h.fiber.uid = null; h.listener(h.fiber); expect(h.fence).toHaveBeenCalledOnce()
  })

  it.each([0, 1, 2, 3, 4, 5] as const)('rolls back registrations before synchronous failure at position %s', (position) => {
    const order: string[] = []; const fiber = { uid: 1 }
    const registrations = Array.from({ length: 5 }, (_, index) => () => { if (index + 1 === position) throw new Error('setup')
      order.push(`register:${index}`); return () => { order.push(`dispose:${index}`) } })
    const subscribe = () => { if (position === 0) throw new Error('setup'); order.push('register:listener')
      return () => { order.push('dispose:listener') } }
    expect(() => new PhoneStreamOwner(fiber, subscribe, registrations, () => {}, { http: async () => {}, transport: async () => {}, relay: async () => {} })).toThrow('setup')
    const acquired = position === 0 ? [] : ['dispose:listener', ...Array.from({ length: position - 1 }, (_, index) => `dispose:${index}`)].reverse()
    expect(order.filter(value => value.startsWith('dispose'))).toEqual(acquired)
  })

  it('preserves setup error then every reverse rollback failure', () => {
    const setup = new Error('setup'); const failures = [new Error('first'), new Error('second')]; const order: number[] = []
    let caught: unknown
    try {
      new PhoneStreamOwner({ uid: 1 }, () => () => { order.push(0); throw failures[0] }, [() => () => { order.push(1)
        throw failures[1] }, () => { throw setup }], () => {}, { http: async () => {}, transport: async () => {}, relay: async () => {} })
    } catch (error) { caught = error }
    expect(order).toEqual([1, 0]); expect((caught as AggregateError).errors).toEqual([setup, failures[1], failures[0]])
  })

  it('publishes closing before a reentrant fence and contains its failure first', async () => {
    const holder: { owner?: PhoneStreamOwner } = {}; let nested: ReturnType<PhoneStreamOwner['beginClosing']> | undefined
    const failure = new Error('fence'); const transport = vi.fn(async () => {}); const relay = vi.fn(async () => {})
    const owner = new PhoneStreamOwner({ uid: 1 }, () => () => {}, [], () => { nested = holder.owner!.beginClosing()
      throw failure }, { http: async () => {}, transport, relay })
    holder.owner = owner
    const closing = owner.beginClosing(); expect(nested).toBe(closing)
    await vi.waitFor(() => { expect(transport).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(relay).toHaveBeenCalledOnce() })
    await expect(owner.dispose()).rejects.toBe(failure)
  })

  it('publishes closing before foreign lanes reenter and starts both despite throw', async () => {
    const fiber = { uid: 1 }; const holder: { owner?: PhoneStreamOwner } = {}; const transportError = new Error('transport')
    const relay = vi.fn(async () => {})
    const owner = new PhoneStreamOwner(fiber, () => () => {}, [], vi.fn(), {
      http: async () => {},
      transport: () => {
        expect(holder.owner?.beginClosing()).toBe(holder.owner?.beginClosing())
        throw transportError
      },
      relay,
    })
    holder.owner = owner
    const closing = owner.beginClosing(); expect(owner.beginClosing()).toBe(closing)
    await expect(closing.transport).rejects.toBe(transportError)
    await Promise.resolve(); expect(relay).toHaveBeenCalledOnce()
  })

  it('admits HTTP work after the owner fence and before HTTP close', async () => {
    let closing = false
    const tx = new PhoneHttpTransactions(async (task) => {
      await task
      return 'settled'
    })
    const owner = new PhoneStreamOwner({ uid: 1 }, () => () => {}, [], () => { closing = true }, {
      http: () => tx.close(new Error('stop')),
      transport: async () => {},
      relay: async () => {},
    })
    owner.beginClosing()
    let handlerEntered = false
    let backendCalled = false
    const reject = vi.fn()
    const work = tx.run(async () => {
      handlerEntered = true
      if (closing) return
      backendCalled = true
    }, reject)
    expect({ closing, handlerEntered }).toEqual({ closing: true, handlerEntered: true })
    expect(backendCalled).toBe(false)
    expect(reject).not.toHaveBeenCalled()
    await owner.dispose()
    await work
  })

  it('keeps registrations live and starts each close lane only after its predecessor', async () => {
    const h = harness(); const disposing = h.owner.dispose(); expect(h.order.filter(x => x.startsWith('dispose'))).toEqual([])
    expect(h.transport.promise).not.toBeUndefined()
    await Promise.resolve()
    h.transport.resolve(); await Promise.resolve(); expect(h.order.filter(x => x.startsWith('dispose'))).toEqual([])
    h.relay.resolve(); await disposing
    expect(h.order.filter(x => x.startsWith('dispose'))).toEqual(['dispose:4', 'dispose:3', 'dispose:2', 'dispose:1', 'dispose:0', 'dispose:listener'])
  })

  it('aggregates close then reverse unregister failures and memoizes disposal', async () => {
    const transport = new Error('transport')
    const relay = new Error('relay')
    const unregister = [new Error('u0'), new Error('u1')]
    const owner = new PhoneStreamOwner(
      { uid: 1 },
      () => () => { throw unregister[0] },
      [() => () => { throw unregister[1] }],
      () => {},
      { http: async () => {}, transport: async () => { throw transport }, relay: async () => { throw relay } },
    )
    const first = owner.dispose(); expect(owner.dispose()).toBe(first)
    await expect(first).rejects.toMatchObject({ errors: [transport, relay, unregister[1], unregister[0]] })
  })
})
