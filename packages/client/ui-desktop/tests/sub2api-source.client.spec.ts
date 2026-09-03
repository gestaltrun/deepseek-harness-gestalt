import { describe, expect, it, vi } from 'vitest'
import {
  bindDesktopSub2Api, createDesktopSub2ApiSource, INITIAL_SUB2API_SNAPSHOT,
} from '../src/client/sub2api-source.ts'
import type { DesktopSub2ApiSnapshot } from '../src/protocol.ts'

describe('createDesktopSub2ApiSource', () => {
  it('starts missing and notifies subscribers on set', () => {
    const source = createDesktopSub2ApiSource()
    expect(source.getSnapshot()).toEqual(INITIAL_SUB2API_SNAPSHOT)
    const listener = vi.fn()
    const stop = source.subscribe(listener)
    source.set({ state: 'running', enabled: true })
    expect(source.getSnapshot()).toEqual({ state: 'running', enabled: true })
    expect(listener).toHaveBeenCalledOnce()
    stop()
    source.set(INITIAL_SUB2API_SNAPSHOT)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('contains subscriber failures and keeps notifying later subscribers', () => {
    const report = vi.fn()
    const source = createDesktopSub2ApiSource(report)
    source.subscribe(() => { throw new Error('gone') })
    const later = vi.fn()
    source.subscribe(later)

    source.set({ state: 'starting', enabled: true })

    expect(report).toHaveBeenCalledOnce()
    expect(later).toHaveBeenCalledOnce()
  })

  it('reports subscriber and initial-read failures through the default diagnostics', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = createDesktopSub2ApiSource()
    source.subscribe(() => { throw new Error('subscriber gone') })
    source.set(INITIAL_SUB2API_SNAPSHOT)
    bindDesktopSub2Api(source, {
      sub2ApiGetSnapshot: () => Promise.reject(new Error('ipc gone')),
      onSub2ApiSnapshot: () => () => {},
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('keeps a pushed state when the initial read resolves late', async () => {
    let resolveInitial: ((snapshot: DesktopSub2ApiSnapshot) => void) | undefined
    let push: ((snapshot: DesktopSub2ApiSnapshot) => void) | undefined
    const source = createDesktopSub2ApiSource()
    const stop = bindDesktopSub2Api(source, {
      sub2ApiGetSnapshot: () => new Promise((resolve) => { resolveInitial = resolve }),
      onSub2ApiSnapshot: (listener) => {
        push = listener
        return vi.fn()
      },
    })
    push?.({ state: 'running', enabled: true })
    resolveInitial?.(INITIAL_SUB2API_SNAPSHOT)
    await Promise.resolve()

    expect(source.getSnapshot()).toEqual({ state: 'running', enabled: true })
    stop()
  })

  it('applies an initial read when no push wins', async () => {
    const source = createDesktopSub2ApiSource()
    bindDesktopSub2Api(source, {
      sub2ApiGetSnapshot: async () => ({ state: 'installed', enabled: false, version: '0.1.0' }),
      onSub2ApiSnapshot: () => () => {},
    })
    await Promise.resolve()

    expect(source.getSnapshot()).toEqual({ state: 'installed', enabled: false, version: '0.1.0' })
  })

  it('reports a live initial read failure and ignores writes after disposal', async () => {
    const liveReport = vi.fn()
    bindDesktopSub2Api(createDesktopSub2ApiSource(), {
      sub2ApiGetSnapshot: () => Promise.reject(new Error('live ipc gone')),
      onSub2ApiSnapshot: () => () => {},
    }, liveReport)
    await Promise.resolve()
    await Promise.resolve()
    expect(liveReport).toHaveBeenCalledOnce()

    let push: ((snapshot: DesktopSub2ApiSnapshot) => void) | undefined
    const disposedReport = vi.fn()
    const unsubscribe = vi.fn()
    const source = createDesktopSub2ApiSource()
    const stop = bindDesktopSub2Api(source, {
      sub2ApiGetSnapshot: () => Promise.reject(new Error('disposed ipc gone')),
      onSub2ApiSnapshot: (listener) => {
        push = listener
        return unsubscribe
      },
    }, disposedReport)
    stop()
    push?.(INITIAL_SUB2API_SNAPSHOT)
    await Promise.resolve()
    await Promise.resolve()

    expect(source.getSnapshot()).toEqual(INITIAL_SUB2API_SNAPSHOT)
    expect(disposedReport).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
