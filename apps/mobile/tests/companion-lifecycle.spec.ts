// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { settleCompanionInteraction, type CompanionInteraction } from '../src/companion-approval.ts'
import {
  bindCompanionProcessVisibility,
  companionMayMutate,
  CompanionForegroundRuntime,
  markCompanionSocketOpen,
  setCompanionForeground,
} from '../src/companion-lifecycle.ts'

const grant = {
  routeId: parseRelayRouteId('route-companion'),
  endpoint: 'mobile' as const,
  credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
  revision: 1,
}

const ready = { foreground: true, socketOpen: true, synchronized: true }
const validatedResync = { type: 'desktop-resync', version: 1, authenticated: true } as const
const approval: CompanionInteraction = {
  operationId: 'op-approve',
  kind: 'approval',
  summary: 'write a.ts',
  authorized: ['once'],
}

describe('Companion foreground lifecycle', () => {
  it('keeps mutations disabled until foreground reconnect and Desktop-authoritative synchronization finish', () => {
    const background = setCompanionForeground(ready, false)
    expect(background).toEqual({ foreground: false, socketOpen: false, synchronized: false })
    expect(companionMayMutate(background)).toBe(false)

    const reconnecting = setCompanionForeground(background, true)
    expect(reconnecting).toEqual({ foreground: true, socketOpen: false, synchronized: false })
    expect(companionMayMutate(reconnecting)).toBe(false)

    const attached = markCompanionSocketOpen(reconnecting)
    expect(companionMayMutate(attached)).toBe(false)

    const synchronized = { ...attached, synchronized: true }
    expect(companionMayMutate(synchronized)).toBe(true)
    expect(companionMayMutate({ ...background, synchronized: true })).toBe(false)
  })

  it('refuses settlement while unsynchronized', () => {
    const background = setCompanionForeground(ready, false)
    expect(settleCompanionInteraction(approval, { accepted: true, decision: 'once' }, background).settled)
      .toBeUndefined()
    const reconnecting = setCompanionForeground(background, true)
    expect(settleCompanionInteraction(approval, { accepted: true, decision: 'once' }, reconnecting).settled)
      .toBeUndefined()
    const attached = markCompanionSocketOpen(reconnecting)
    expect(settleCompanionInteraction(approval, { accepted: true, decision: 'once' }, attached).settled)
      .toBeUndefined()
    expect(settleCompanionInteraction(approval, { accepted: true, decision: 'once' }, ready).settled)
      .toEqual({ decision: 'once' })
  })

  it('stops the real Relay lifecycle on background and opens a socket only after isConnected', async () => {
    const relay = {
      configure: () => {},
      start: async () => {},
      stop: async () => {},
      isConnected: () => false,
    }
    const started: string[] = []
    relay.start = async () => { started.push('start') }
    relay.stop = async () => { started.push('stop') }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    await runtime.setForeground(false)
    expect(started).toEqual(['stop'])
    expect(companionMayMutate(runtime.getState())).toBe(false)
    await runtime.setForeground(true)
    expect(started).toEqual(['stop', 'start'])
    expect(runtime.getState().socketOpen).toBe(false)
    relay.isConnected = () => true
    await runtime.setForeground(true)
    expect(runtime.getState().socketOpen).toBe(true)
    expect(runtime.getState().synchronized).toBe(false)
    expect(companionMayMutate(runtime.getState())).toBe(false)
  })

  it('serializes foreground transitions so a late stop cannot tear down a newer start', async () => {
    let releaseStop: (() => void) | undefined
    const order: string[] = []
    const relay = {
      start: async () => { order.push('start') },
      stop: async () => {
        order.push('stop-enter')
        await new Promise<void>((resolve) => { releaseStop = resolve })
        order.push('stop-exit')
      },
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    const background = runtime.setForeground(false)
    const foreground = runtime.setForeground(true)
    await Promise.resolve()
    expect(order).toEqual(['stop-enter'])
    if (releaseStop === undefined) throw new Error('expected stop to start')
    releaseStop()
    await foreground
    await background
    expect(order).toEqual(['stop-enter', 'stop-exit', 'start'])
    expect(runtime.getState().socketOpen).toBe(true)
  })

  it('does not start Relay on visibilitychange after releasePairing', async () => {
    const started: string[] = []
    const relay = {
      configure: () => {},
      start: async () => { started.push('start') },
      stop: async () => { started.push('stop') },
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    const dispose = bindCompanionProcessVisibility(runtime)
    await runtime.setForeground(true)
    expect(started).toEqual(['start'])
    const receiver = runtime.bindValidatedDesktopResync()
    if (receiver === undefined) throw new Error('expected Desktop resync receiver')
    receiver.acceptValidatedDesktopResync(validatedResync)
    expect(companionMayMutate(runtime.getState())).toBe(true)
    await runtime.releasePairing()
    started.length = 0
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => { expect(runtime.getState().foreground).toBe(true) })
    expect(started).toEqual([])
    expect(companionMayMutate(runtime.getState())).toBe(false)
    await dispose()
  })

  it('does not reopen mutation when releasePairing races an in-flight start', async () => {
    let releaseStart: (() => void) | undefined
    const started: string[] = []
    const relay = {
      configure: () => {},
      start: async () => {
        started.push('start')
        await new Promise<void>((resolve) => { releaseStart = resolve })
      },
      stop: async () => { started.push('stop') },
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    const starting = runtime.start()
    await Promise.resolve()
    expect(started).toEqual(['start'])
    const releasing = runtime.releasePairing()
    if (releaseStart === undefined) throw new Error('expected start to be pending')
    releaseStart()
    await starting
    await releasing
    expect(runtime.bindValidatedDesktopResync()).toBeUndefined()
    expect(companionMayMutate(runtime.getState())).toBe(false)
    expect(started.filter(step => step === 'start')).toHaveLength(1)
  })

  it('invalidates a validated resync receiver across physical reconnect generations', () => {
    const runtime = new CompanionForegroundRuntime()
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const first = runtime.bindValidatedDesktopResync()
    if (first === undefined) throw new Error('expected first resync receiver')
    first.acceptValidatedDesktopResync(validatedResync)
    expect(companionMayMutate(runtime.getState())).toBe(true)

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    first.acceptValidatedDesktopResync(validatedResync)
    expect(companionMayMutate(runtime.getState())).toBe(false)

    const replacement = runtime.bindValidatedDesktopResync()
    if (replacement === undefined) throw new Error('expected replacement resync receiver')
    replacement.acceptValidatedDesktopResync(validatedResync)
    expect(companionMayMutate(runtime.getState())).toBe(true)
  })

  it('invalidates a mutation permit across backgrounding and physical replacement', async () => {
    const runtime = new CompanionForegroundRuntime()
    runtime.configure(grant)
    expect(runtime.bindCompanionMutationPermit('attachment')).toBeUndefined()
    runtime.markConnectionOpen()
    const permit = runtime.bindCompanionMutationPermit('attachment')
    const resync = runtime.bindValidatedDesktopResync()
    if (permit === undefined || resync === undefined) throw new Error('expected current generation authority')
    expect(() => { permit.requireCurrent() }).toThrow(/foreground synchronization/)
    resync.acceptValidatedDesktopResync(validatedResync)
    expect(() => { permit.requireCurrent() }).not.toThrow()

    await runtime.setForeground(false)
    expect(permit.isCurrent()).toBe(false)
    expect(() => { permit.requireCurrent() }).toThrow(/connection generation/)

    await runtime.setForeground(true)
    runtime.markConnectionOpen()
    const replacement = runtime.bindValidatedDesktopResync()
    if (replacement === undefined) throw new Error('expected replacement generation authority')
    replacement.acceptValidatedDesktopResync(validatedResync)
    expect(() => { permit.requireCurrent() }).toThrow(/connection generation/)

    const replacementPermit = runtime.bindCompanionMutationPermit('attachment')
    if (replacementPermit === undefined) throw new Error('expected replacement mutation permit')
    expect(() => { replacementPermit.requireCurrent() }).not.toThrow()
    runtime.configure({ ...grant, revision: 2 })
    expect(replacementPermit.isCurrent()).toBe(false)
    expect(() => { replacementPermit.requireCurrent() }).toThrow(/connection generation/)
  })

  it('removes a Capacitor listener that resolves after dispose starts', async () => {
    let resolveHandle: ((handle: { remove: () => Promise<void> }) => void) | undefined
    const remove = vi.fn(async () => {})
    const pending = new Promise<{ remove: () => Promise<void> }>((resolve) => {
      resolveHandle = resolve
    })
    const runtime = new CompanionForegroundRuntime()
    const dispose = bindCompanionProcessVisibility(runtime, {
      listenAppState: async () => pending,
    })
    const disposing = dispose()
    if (resolveHandle === undefined) throw new Error('expected listener factory to run')
    resolveHandle({ remove })
    await disposing
    expect(remove).toHaveBeenCalledOnce()
  })
})
