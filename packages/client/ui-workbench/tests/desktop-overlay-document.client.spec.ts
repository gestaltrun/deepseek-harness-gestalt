// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply as applyClient, inject as clientInject } from '../src/client/index.ts'
import { isDesktopOverlayDocument } from '../src/desktop-overlay-document.ts'

afterEach(() => {
  document.documentElement.removeAttribute('data-dsh-desktop-overlay')
  vi.unstubAllGlobals()
})

describe('isDesktopOverlayDocument', () => {
  it('reads the overlay attribute and query', () => {
    expect(isDesktopOverlayDocument()).toBe(false)
    document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
    expect(isDesktopOverlayDocument()).toBe(true)
    document.documentElement.removeAttribute('data-dsh-desktop-overlay')
    vi.stubGlobal('location', { search: '?dsh-desktop-overlay=1' })
    expect(isDesktopOverlayDocument()).toBe(true)
    vi.stubGlobal('location', { search: '' })
    expect(isDesktopOverlayDocument()).toBe(false)
  })
})

describe('workbench apply on the overlay document', () => {
  it('publishes the face and does not tick official-page reconcile', async () => {
    document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
    const ctx = new Context()
    class RemoteService extends Service {
      constructor() { super(ctx, 'remote') }
    }
    new RemoteService()
    const create = vi.fn()
    const subscribeState = vi.fn()
    const subscribe = vi.fn()
    ctx.provide('betterSidebar', {
      openTab: vi.fn(),
      updateTab: vi.fn(),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      setPanelOpen: vi.fn(),
      getSnapshot: () => ({
        sessionId: 's1',
        state: {
          panelOpen: true,
          splits: { kind: 'leaf' as const, tabs: [{ id: 'browser:1', type: 'browser' }] },
        },
      }),
      subscribeState,
    })
    ctx.provide('remote.browserWorkspace', { create })
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ byId: {} }), subscribe },
    })
    ctx.provide('settingsScope', {
      bind: () => ({ getSnapshot: () => ({ value: undefined }) }),
    })
    await ctx.plugin({ inject: [...clientInject], apply: applyClient }).await()
    const face = ctx.get('workbenchBrowser') as {
      ensureOfficial: (tabId: string) => void
      createRequest: () => { profile: string }
    }
    expect(typeof face.ensureOfficial).toBe('function')
    expect(typeof face.createRequest).toBe('function')
    face.ensureOfficial('browser:1')
    expect(face.createRequest()).toEqual({ profile: 'shared' })
    expect(create).not.toHaveBeenCalled()
    expect(subscribeState).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })
})
