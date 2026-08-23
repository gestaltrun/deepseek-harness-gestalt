import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { parseAttachmentBlobReservationId, parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseAttachmentCapability, REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import {
  apply,
  Config,
  RemoteAttachmentStoreProvider,
  type RemoteAttachmentStoreOptions,
} from '../src/index.ts'
import * as StorePlugin from '../src/index.ts'

const now = 1_000_000
const pairingA = parsePersonalPairingId('pairing-a')
const pairingB = parsePersonalPairingId('pairing-b')
const quotaId = parseAttachmentBlobReservationId

function store(overrides: Partial<RemoteAttachmentStoreOptions> = {}): RemoteAttachmentStoreProvider {
  return new RemoteAttachmentStoreProvider(new Context(), {
    maxBlobBytes: 8,
    capabilityLifetimeMs: 1_000,
    maxRetainedBlobs: 2,
    sweepIntervalMs: 60_000,
    schedule: () => ({ unref: vi.fn(), cancel: vi.fn() }),
    ...overrides,
  })
}

describe('Remote attachment blob store', () => {
  it('retains ciphertext only and issues one single-use pairing-scoped capability', async () => {
    const service = store()
    const ciphertext = Uint8Array.of(1, 2, 3, 4)
    const grant = await service.publish({ pairingId: pairingA, ciphertext, now })
    expect(parseAttachmentCapability(grant.capability)).toBe(grant.capability)
    expect(grant.byteLength).toBe(4)
    expect(grant.expiresAt).toBe(now + 1_000)
    expect(service.observe()).toHaveLength(1)
    expect(service.observe()[0]).toMatchObject({ pairingId: pairingA, expiresAt: now + 1_000 })

    const consumption = await service.consume({ pairingId: pairingA, capability: grant.capability, now })
    expect(consumption.ciphertext).toEqual(ciphertext)
    await consumption.complete()
    expect(service.observe()).toHaveLength(0)
    await expect(service.consume({ pairingId: pairingA, capability: grant.capability, now }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
  })

  it('claims a capability synchronously before another in-process consumer can observe it', async () => {
    const service = store()
    const grant = await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })

    const [first, second] = await Promise.allSettled([
      service.consume({ pairingId: pairingA, capability: grant.capability, now }),
      service.consume({ pairingId: pairingA, capability: grant.capability, now }),
    ])

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('copies ciphertext on publish, observe, inspect, and consume so caller mutation cannot leak', async () => {
    const service = store()
    const ciphertext = Uint8Array.of(1, 2, 3, 4)
    const grant = await service.publish({ pairingId: pairingA, ciphertext, now })
    ciphertext[0] = 9
    const observed = service.observe()[0]
    if (observed === undefined) throw new Error('published blob was not retained')
    expect(observed.ciphertext).toEqual(Uint8Array.of(1, 2, 3, 4))
    observed.ciphertext[0] = 7
    expect(service.observe()[0]?.ciphertext).toEqual(Uint8Array.of(1, 2, 3, 4))
    const inspected = await service.inspect({ pairingId: pairingA, capability: grant.capability, now })
    expect(inspected).toEqual(Uint8Array.of(1, 2, 3, 4))
    inspected[0] = 5
    expect(service.observe()).toHaveLength(1)
    const consumed = await service.consume({ pairingId: pairingA, capability: grant.capability, now })
    expect(consumed.ciphertext).toEqual(Uint8Array.of(1, 2, 3, 4))
    consumed.ciphertext[0] = 3
    await consumed.complete()
    expect(service.observe()).toHaveLength(0)
  })

  it('settles quota once across complete, retryable abandon, expired abandon, and revoke', async () => {
    const service = store()
    const release = vi.fn(async () => {})
    const completed = await service.publish({
      pairingId: pairingA, ciphertext: Uint8Array.of(1), now,
      quota: { id: quotaId('quota-complete'), release },
    })
    const completedClaim = await service.consume({ pairingId: pairingA, capability: completed.capability, now })
    await completedClaim.complete()
    await completedClaim.complete()

    const retryable = await service.publish({
      pairingId: pairingA, ciphertext: Uint8Array.of(2), now,
      quota: { id: quotaId('quota-retryable'), release },
    })
    const retryableClaim = await service.consume({ pairingId: pairingA, capability: retryable.capability, now })
    await retryableClaim.abandon(now)
    await retryableClaim.abandon(now)
    const retried = await service.consume({ pairingId: pairingA, capability: retryable.capability, now })
    await retried.complete()

    const expired = await service.publish({
      pairingId: pairingA, ciphertext: Uint8Array.of(3), now,
      quota: { id: quotaId('quota-expired'), release },
    })
    const expiredClaim = await service.consume({ pairingId: pairingA, capability: expired.capability, now })
    await expiredClaim.abandon(now + 1_000)

    const revoked = await service.publish({
      pairingId: pairingA, ciphertext: Uint8Array.of(4), now,
      quota: { id: quotaId('quota-revoked'), release },
    })
    await service.revoke({ pairingId: pairingA, capability: revoked.capability })

    expect(release).toHaveBeenCalledTimes(4)
    expect(service.observe()).toHaveLength(0)
  })

  it('rejects cross-pairing use without consuming the blob', async () => {
    const service = store()
    const grant = await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })
    await expect(service.consume({ pairingId: pairingB, capability: grant.capability, now }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PAIRING_MISMATCH' })
    expect(service.observe()).toHaveLength(1)
  })

  it('removes the blob and capability on lazy expiry', async () => {
    const service = store()
    const grant = await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })
    await expect(service.consume({ pairingId: pairingA, capability: grant.capability, now: now + 1_000 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
    expect(service.observe()).toHaveLength(0)
  })

  it('awaits quota release when inspect observes lazy expiry', async () => {
    const service = store()
    const release = vi.fn(async () => {})
    const grant = await service.publish({
      pairingId: pairingA,
      ciphertext: Uint8Array.of(1),
      now,
      quota: { id: quotaId('quota-inspect-expired'), release },
    })

    await expect(service.inspect({ pairingId: pairingA, capability: grant.capability, now: now + 1_000 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
    expect(release).toHaveBeenCalledOnce()
    expect(service.observe()).toHaveLength(0)
  })

  it('removes the blob and capability on revocation, and rejects cross-pairing revocation', async () => {
    const service = store()
    const grant = await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })
    await expect(service.revoke({ pairingId: pairingB, capability: grant.capability }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PAIRING_MISMATCH' })
    expect(service.observe()).toHaveLength(1)
    await service.revoke({ pairingId: pairingA, capability: grant.capability })
    expect(service.observe()).toHaveLength(0)
    await expect(service.consume({ pairingId: pairingA, capability: grant.capability, now }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
    await expect(service.revoke({ pairingId: pairingA, capability: grant.capability })).resolves.toBeUndefined()
  })

  it('rejects empty ciphertext as empty, not as a limit breach', async () => {
    const service = store()
    const release = vi.fn(async () => {})
    await expect(service.publish({
      pairingId: pairingA, ciphertext: new Uint8Array(0), now,
      quota: { id: quotaId('quota-empty'), release },
    }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EMPTY' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('enforces the per-blob byte ceiling on the complete ciphertext', async () => {
    const service = store()
    const release = vi.fn(async () => {})
    await expect(service.publish({
      pairingId: pairingA, ciphertext: new Uint8Array(9), now,
      quota: { id: quotaId('quota-oversize'), release },
    }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT_EXCEEDED' })
    expect(release).toHaveBeenCalledOnce()
    await expect(service.publish({ pairingId: pairingA, ciphertext: new Uint8Array(8), now }))
      .resolves.toMatchObject({ byteLength: 8 })
  })

  it('fails explicitly at retained-blob capacity after sweeping expired entries', async () => {
    const service = store()
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(2), now })
    const release = vi.fn(async () => {})
    await expect(service.publish({
      pairingId: pairingA, ciphertext: Uint8Array.of(3), now,
      quota: { id: quotaId('quota-capacity'), release },
    }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPACITY' })
    expect(release).toHaveBeenCalledOnce()
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(4), now: now + 2_000 })
    expect(service.observe()).toHaveLength(1)
  })

  it('sweeps expired blobs on every re-armed tick and stops after disposal', async () => {
    const ticks: (() => void)[] = []
    const cancels: ReturnType<typeof vi.fn>[] = []
    const service = new RemoteAttachmentStoreProvider(new Context(), {
      maxBlobBytes: 8,
      capabilityLifetimeMs: 1,
      maxRetainedBlobs: 2,
      sweepIntervalMs: 60_000,
      schedule: (handler) => {
        ticks.push(handler)
        const cancel = vi.fn()
        cancels.push(cancel)
        return { unref: vi.fn(), cancel }
      },
    })
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now: Date.now() })
    await new Promise(resolve => setTimeout(resolve, 2))
    const first = ticks[0]
    if (first === undefined) throw new Error('sweep timer was not armed')
    first()
    await vi.waitFor(() => { expect(service.observe()).toHaveLength(0) })
    await vi.waitFor(() => { expect(ticks).toHaveLength(2) })
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(2), now: Date.now() })
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = ticks[1]
    if (second === undefined) throw new Error('sweep timer was not re-armed')
    second()
    await vi.waitFor(() => { expect(service.observe()).toHaveLength(0) })
    await vi.waitFor(() => { expect(ticks).toHaveLength(3) })
    await service.dispose()
    expect(cancels.some(cancel => cancel.mock.calls.length > 0)).toBe(true)
    const armed = ticks.length
    const last = ticks[armed - 1]
    if (last === undefined) throw new Error('expected a re-armed timer')
    last()
    expect(ticks.length).toBe(armed)
  })

  it('rejects misconfiguration above the accepted protocol ceilings', () => {
    expect(() => store({ maxBlobBytes: 100 * 1_024 * 1_024 + 1 })).toThrow(TypeError)
    expect(() => store({ capabilityLifetimeMs: 15 * 60 * 1000 + 1 })).toThrow(TypeError)
    expect(() => store({ sweepIntervalMs: 0 })).toThrow(TypeError)
    expect(() => store({ maxRetainedBlobs: 0 })).toThrow(TypeError)
    expect(() => store({ maxRetainedBlobs: 1.5 })).toThrow(TypeError)
    expect(() => store({ maxBlobBytes: 100 * 1_024 * 1_024, capabilityLifetimeMs: 15 * 60 * 1000 }))
      .not.toThrow()
  })

  it('clears retained blobs when the provider is disposed', async () => {
    const service = store()
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })
    await service.dispose()
    expect(service.observe()).toHaveLength(0)
  })

  it('contains a rejected quota release during disposal expiry cleanup', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = store()
    await service.publish({
      pairingId: pairingA,
      ciphertext: Uint8Array.of(1),
      now,
      quota: { id: quotaId('quota-dispose'), release: async () => { throw new Error('quota backend unavailable') } },
    })

    await service.dispose()
    expect(reported).toHaveBeenCalledWith(
      '[remote-attachments] quota release failed:',
      expect.objectContaining({ message: 'quota backend unavailable' }),
    )
    reported.mockRestore()
  })

  it('waits for expired quota release before lazy expiry and disposal settle', async () => {
    let settleRelease!: () => void
    const release = vi.fn(async () => {
      await new Promise<void>((resolve) => { settleRelease = () => { resolve() } })
    })
    const service = store()
    const grant = await service.publish({
      pairingId: pairingA,
      ciphertext: Uint8Array.of(1),
      now,
      quota: { id: quotaId('quota-expired-awaited'), release },
    })

    let expiredSettled = false
    const expired = service.consume({ pairingId: pairingA, capability: grant.capability, now: now + 1_000 })
      .catch((error: unknown) => { expiredSettled = true; throw error })
    await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce() })
    expect(expiredSettled).toBe(false)
    settleRelease()
    await expect(expired).rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
    await expect(service.dispose()).resolves.toBeUndefined()
  })

  it('defaults bounds to the accepted protocol ceilings and disposes with the owning fiber', async () => {
    const ctx = new Context()
    const service = new RemoteAttachmentStoreProvider(ctx, {
      maxRetainedBlobs: 2,
      sweepIntervalMs: 60_000,
    })
    expect(service.maxBlobBytes).toBe(REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes)
    expect(service.capabilityLifetimeMs).toBe(REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs)
    await service.publish({ pairingId: pairingA, ciphertext: Uint8Array.of(1), now })
    await ctx.fiber.dispose()
    expect(service.observe()).toHaveLength(0)
  })

  it('mounts the store from plugin Config and keeps the function-plugin namespace free of a default export', () => {
    const ctx = new Context()
    apply(ctx, { maxRetainedBlobs: 2, sweepIntervalMs: 60_000, maxBlobBytes: 8 })
    expect(ctx.remoteAttachments.maxBlobBytes).toBe(8)
    expect(() => Config({ maxRetainedBlobs: 0, sweepIntervalMs: 1 })).toThrow()
    expect('default' in StorePlugin).toBe(false)
  })
})
