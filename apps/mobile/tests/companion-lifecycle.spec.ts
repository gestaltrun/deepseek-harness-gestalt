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

  it('retains a recognizable connection failure until a fresh attachment opens', () => {
    const runtime = new CompanionForegroundRuntime()
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = runtime.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync(validatedResync)

    runtime.reportConnectionFailure({
      code: 'COMPANION_SECURITY_CAPABILITY_MISSING',
      message: 'Desktop update required',
      updateEndpoint: 'desktop',
    })

    expect(runtime.getState()).toEqual({
      foreground: true,
      socketOpen: false,
      synchronized: false,
      connectionFailure: {
        code: 'COMPANION_SECURITY_CAPABILITY_MISSING',
        message: 'Desktop update required',
        updateEndpoint: 'desktop',
      },
    })
    expect(companionMayMutate(runtime.getState())).toBe(false)

    runtime.markConnectionOpen()
    expect(runtime.getState()).toEqual({
      foreground: true,
      socketOpen: true,
      synchronized: false,
    })
  })

  it('replaces an authenticated peer without closing or reopening its Relay socket', () => {
    const runtime = new CompanionForegroundRuntime()
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const first = runtime.bindValidatedDesktopResync()
    if (first === undefined) throw new Error('expected first peer resync receiver')
    first.acceptValidatedDesktopResync(validatedResync)

    runtime.invalidateAuthenticatedPeer()
    expect(runtime.getState()).toMatchObject({ socketOpen: true, synchronized: false })
    first.acceptValidatedDesktopResync(validatedResync)
    expect(companionMayMutate(runtime.getState())).toBe(false)

    runtime.markAuthenticatedPeer()
    const replacement = runtime.bindValidatedDesktopResync()
    if (replacement === undefined) throw new Error('expected same-socket replacement resync receiver')
    replacement.acceptValidatedDesktopResync(validatedResync)
    expect(runtime.getState()).toMatchObject({ socketOpen: true, synchronized: true })
    expect(companionMayMutate(runtime.getState())).toBe(true)
  })

  it('keeps a synchronized connection stable across duplicate foreground signals', async () => {
    const relay = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = runtime.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync(validatedResync)
    const states: string[] = []
    runtime.subscribe(() => {
      const state = runtime.getState()
      states.push(`${String(state.socketOpen)}:${String(state.synchronized)}`)
    })

    await runtime.setForeground(true)

    expect(states).toEqual([])
    expect(relay.start).not.toHaveBeenCalled()
    expect(runtime.getState()).toEqual(ready)
  })

  it('recovers an authenticated peer after a live Relay reports it offline', () => {
    const relay = {
      start: async () => {},
      stop: async () => {},
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const first = runtime.bindValidatedDesktopResync()
    if (first === undefined) throw new Error('expected first peer resync receiver')
    first.acceptValidatedDesktopResync(validatedResync)

    runtime.reportConnectionFailure({ code: 'REMOTE_OFFLINE', message: 'Paired Desktop is Remote Offline' })
    expect(runtime.getState()).toMatchObject({ socketOpen: true, synchronized: false })

    runtime.markAuthenticatedPeer()
    const replacement = runtime.bindValidatedDesktopResync()
    if (replacement === undefined) throw new Error('expected live-socket replacement resync receiver')
    replacement.acceptValidatedDesktopResync(validatedResync)
    expect(runtime.getState()).toEqual(ready)
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
      readAppState: async () => true,
      isNativePlatform: () => true,
    })
    const disposing = dispose()
    if (resolveHandle === undefined) throw new Error('expected listener factory to run')
    resolveHandle({ remove })
    await disposing
    expect(remove).toHaveBeenCalledOnce()
  })

  it('initializes native App state before ignoring conflicting document visibility', async () => {
    const relay = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    await runtime.setForeground(false)
    relay.stop.mockClear()
    const readAppState = vi.fn(async () => true)
    const dispose = bindCompanionProcessVisibility(runtime, {
      listenAppState: async () => ({ remove: async () => {} }),
      readAppState,
      isNativePlatform: () => true,
    })
    await vi.waitFor(() => {
      expect(readAppState).toHaveBeenCalledOnce()
      expect(runtime.getState()).toMatchObject({ foreground: true, socketOpen: true })
    })
    const resync = runtime.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync(validatedResync)
    relay.start.mockClear()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(relay.start).not.toHaveBeenCalled()
    expect(relay.stop).not.toHaveBeenCalled()
    expect(runtime.getState()).toEqual(ready)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    await dispose()
  })

  it('fails closed when the initial native App state cannot be read', async () => {
    let reportAppState: ((active: boolean) => void) | undefined
    const relay = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = runtime.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync(validatedResync)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dispose = bindCompanionProcessVisibility(runtime, {
      listenAppState: async (listener) => {
        reportAppState = listener
        return { remove: async () => {} }
      },
      readAppState: async () => { throw new Error('unavailable') },
      isNativePlatform: () => true,
    })
    await vi.waitFor(() => {
      expect(runtime.getState().foreground).toBe(false)
      expect(consoleError).toHaveBeenCalledWith('[companion-foreground] native App state read failed')
    })

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime.getState().foreground).toBe(false)

    if (reportAppState === undefined) throw new Error('expected App-state listener')
    reportAppState(true)
    await vi.waitFor(() => {
      expect(runtime.getState()).toMatchObject({ foreground: true, socketOpen: true, synchronized: false })
    })
    await dispose()
    consoleError.mockRestore()
  })

  it('fails closed when the native App-state listener cannot be registered', async () => {
    const relay = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const dispose = bindCompanionProcessVisibility(runtime, {
      listenAppState: async () => { throw new Error('unavailable') },
      readAppState: vi.fn(async () => true),
      isNativePlatform: () => true,
    })
    await vi.waitFor(() => { expect(runtime.getState().foreground).toBe(false) })

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime.getState().foreground).toBe(false)
    await dispose()
  })

  it('does not reconcile browser visibility after disposal starts', async () => {
    let rejectListener: ((reason: Error) => void) | undefined
    const relay = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isConnected: () => true,
    }
    const runtime = new CompanionForegroundRuntime({ relay })
    runtime.configure(grant)
    await runtime.setForeground(false)
    relay.start.mockClear()
    const pending = new Promise<{ remove: () => Promise<void> }>((_resolve, reject) => {
      rejectListener = reject
    })
    const dispose = bindCompanionProcessVisibility(runtime, {
      listenAppState: async () => pending,
      isNativePlatform: () => false,
    })
    const disposing = dispose()
    if (rejectListener === undefined) throw new Error('expected listener registration to start')
    rejectListener(new Error('unavailable'))
    await disposing
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(relay.start).not.toHaveBeenCalled()
    expect(runtime.getState().foreground).toBe(false)
  })
})
