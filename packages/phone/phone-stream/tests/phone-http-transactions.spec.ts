import { describe, expect, it, vi } from 'vitest'
import { PhoneHttpTransactions } from '../src/phone-http-transactions.ts'

function gate() { let release!: () => void; return { promise: new Promise<void>((resolve) => { release = resolve }), release } }

describe('PhoneHttpTransactions', () => {
  it('publishes admission before synchronous work reenters close', async () => {
    const holder: { owner?: PhoneHttpTransactions } = {}; let nested!: Promise<void>; const deadline = gate()
    const owner = new PhoneHttpTransactions(async task => await Promise.race([task.then(() => 'settled' as const), deadline.promise.then(() => 'timeout' as const)]))
    holder.owner = owner
    const work = owner.run(async () => { nested = holder.owner!.close(new Error('stop')); await gate().promise }, vi.fn())
    expect(owner.close(new Error('again'))).toBe(nested); expect(owner.ownershipSnapshot()).toBe(0)
    deadline.release(); await expect(nested).rejects.toThrow('cleanup timed out'); void work.catch(() => {})
  })

  it('publishes close before response rejection reenters', async () => {
    const holder: { owner?: PhoneHttpTransactions } = {}; let nested!: Promise<void>; const workGate = gate()
    const owner = new PhoneHttpTransactions(async (task) => { await task; return 'settled' })
    holder.owner = owner
    const work = owner.run(async () => { await workGate.promise }, () => { nested = holder.owner!.close(new Error('nested')) })
    const first = owner.close(new Error('stop')); expect(nested).toBe(first); expect(owner.ownershipSnapshot()).toBe(0)
    workGate.release(); await first; await work
  })

  it('detaches ownership at timeout while late settlement stays observed', async () => {
    const cleanup = gate(); let signal: AbortSignal | undefined; const reject = vi.fn(); const foreign = gate()
    const owner = new PhoneHttpTransactions(async task => await Promise.race([task.then(() => 'settled' as const), cleanup.promise.then(() => 'timeout' as const)]))
    const work = owner.run(async (admitted) => { signal = admitted; await foreign.promise }, reject)
    const first = owner.close(new Error('stop')); expect(owner.close(new Error('again'))).toBe(first)
    expect(signal?.aborted).toBe(true); expect(reject).toHaveBeenCalledOnce(); expect(owner.ownershipSnapshot()).toBe(0)
    cleanup.release(); await expect(first).rejects.toThrow('cleanup timed out')
    foreign.release(); await work
  })

  it('bounds repeated hung transactions without retaining module ownership', async () => {
    const timeout = gate()
    const owner = new PhoneHttpTransactions(async task => await Promise.race([task.then(() => 'settled' as const), timeout.promise.then(() => 'timeout' as const)]))
    const works: Promise<void>[] = []
    for (let index = 0; index < 32; index += 1) works.push(owner.run(async () =>{  await gate().promise }, vi.fn()))
    const close = owner.close(new Error('stop')); expect(owner.ownershipSnapshot()).toBe(0); timeout.release()
    await expect(close).rejects.toThrow('cleanup timed out')
    expect(owner.close(new Error('again'))).toBe(close); works.forEach((work) => { void work.catch(() => {}) })
  })

  it('rejects post-close admission synchronously', async () => {
    const owner = new PhoneHttpTransactions(async (task) => { await task; return 'settled' }); const reject = vi.fn()
    await owner.close(new Error('stop'))
    const work = vi.fn(async () => {}); await owner.run(work, reject); expect(reject).toHaveBeenCalledOnce()
    expect(work).not.toHaveBeenCalled()
  })
})
