import { describe, expect, it, vi } from 'vitest'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime, companionMayMutate } from '../src/companion-lifecycle.ts'
import { MobileNoiseCompanionReceiver } from '../src/noise-companion.ts'

describe('Mobile Noise Companion receiver', () => {
  it('grants mutation authority only after authenticated generation-matching synchronization', () => {
    const runtime = connectedRuntime()
    const open = vi.fn(() => ({
      type: 'projection' as const,
      projection: { type: 'foreground-sync' as const, desktopName: 'Authenticated Desktop', generation: 2, desktopRevision: 7 },
    }))
    const receiver = new MobileNoiseCompanionReceiver({ open }, 2, runtime)

    expect(companionMayMutate(runtime.getState())).toBe(false)
    expect(receiver.receive(Uint8Array.of(9))).toMatchObject({ projection: { desktopRevision: 7 } })
    expect(companionMayMutate(runtime.getState())).toBe(true)
  })

  it('rejects another generation and never promotes an undecodable byte', () => {
    const runtime = connectedRuntime()
    const stale = new MobileNoiseCompanionReceiver({
      open: () => ({
        type: 'projection',
        projection: { type: 'foreground-sync', desktopName: 'Authenticated Desktop', generation: 1, desktopRevision: 7 },
      }),
    }, 2, runtime)
    expect(() => stale.receive(Uint8Array.of(9))).toThrow('another connection generation')
    expect(companionMayMutate(runtime.getState())).toBe(false)

    const invalid = new MobileNoiseCompanionReceiver({
      open: () => { throw new Error('Companion message is not valid protocol JSON') },
    }, 2, runtime)
    expect(() => invalid.receive(Uint8Array.of(1))).toThrow('not valid protocol JSON')
    expect(companionMayMutate(runtime.getState())).toBe(false)
  })

  it('projects a decoded result only through the generation-bound Mobile surface receiver', () => {
    const runtime = connectedRuntime()
    const result = {
      type: 'session-search' as const,
      operationId: 'search-noise' as never,
      items: [],
      hasMore: false,
    }
    const acceptValidatedCompanionResult = vi.fn()
    const receiver = new MobileNoiseCompanionReceiver({
      open: () => ({ type: 'result', result }),
    }, 2, runtime, () => ({ acceptValidatedCompanionResult }))

    expect(receiver.receive(Uint8Array.of(3))).toEqual({ type: 'result', result })
    expect(acceptValidatedCompanionResult).toHaveBeenCalledWith(result)
    runtime.forgetConnection()
    const missing = new MobileNoiseCompanionReceiver({
      open: () => ({ type: 'result', result }),
    }, 2, runtime, () => undefined)
    expect(() => missing.receive(Uint8Array.of(4))).toThrow('no active Mobile surface')
  })
})

function connectedRuntime(): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    endpoint: 'mobile',
    routeId: parseRelayRouteId('route-one'),
    credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    revision: 1,
  })
  runtime.markConnectionOpen()
  return runtime
}
