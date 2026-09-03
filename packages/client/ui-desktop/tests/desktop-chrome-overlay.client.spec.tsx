// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DesktopChromeOverlay, overlayDesktopBridgeOf, overlayMenuIcon,
} from '../src/client/DesktopChromeOverlay.tsx'

afterEach(() => {
  cleanup()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

function mount() {
  return render(<DesktopChromeOverlay />)
}

describe('overlayDesktopBridgeOf', () => {
  it('rejects an incomplete bridge', () => {
    expect(overlayDesktopBridgeOf(undefined)).toBeUndefined()
    expect(overlayDesktopBridgeOf({})).toBeUndefined()
    expect(overlayDesktopBridgeOf({
      chromeOverlayGetState: () => Promise.resolve(null),
      chromeOverlayResult: () => {},
    })).toBeUndefined()
  })
})

describe('overlayMenuIcon', () => {
  it('maps known tab ids and ignores unknown ones', () => {
    expect(overlayMenuIcon(undefined)).toBeUndefined()
    expect(overlayMenuIcon('unknown')).toBeUndefined()
    expect(overlayMenuIcon('editor')).toBeTruthy()
    expect(overlayMenuIcon('git')).toBeTruthy()
    expect(overlayMenuIcon('subagent')).toBeTruthy()
    expect(overlayMenuIcon('sidechat')).toBeTruthy()
    expect(overlayMenuIcon('browser')).toBeTruthy()
    expect(overlayMenuIcon('terminal')).toBeTruthy()
    expect(overlayMenuIcon('phone')).toBeTruthy()
  })
})

describe('DesktopChromeOverlay', () => {
  it('paints nothing without a Desktop bridge', () => {
    mount()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('paints a menu from current state and reports select or close', async () => {
    const result = vi.fn()
    let listener: ((state: unknown) => void) | undefined
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      chromeOverlayGetState: async () => ({
        kind: 'menu',
        requestId: 'req',
        items: [
          { id: 'browser', label: 'Browser', icon: 'browser' },
          { id: 'editor', label: 'Files', disabled: true, icon: 'editor' },
        ],
        anchor: { x: 10, y: 20, width: 24, height: 24 },
        align: 'end',
        side: 'bottom',
      }),
      chromeOverlayResult: result,
      onChromeOverlayState: (next: (state: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    }
    await act(async () => { mount() })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browser' }))
    expect(result).toHaveBeenCalledWith({ type: 'select', requestId: 'req', id: 'browser' })
    await act(async () => { listener?.(null) })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('places a menu with explicit start/top alignment', async () => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      chromeOverlayGetState: async () => ({
        kind: 'menu',
        requestId: 'req',
        items: [{ id: 'browser', label: 'Browser' }],
        anchor: { x: 4, y: 8, width: 16, height: 16 },
        align: 'start',
        side: 'top',
      }),
      chromeOverlayResult: () => {},
      onChromeOverlayState: () => () => {},
    }
    await act(async () => { mount() })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('paints an svg for a phone overlay row', async () => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      chromeOverlayGetState: async () => ({
        kind: 'menu',
        requestId: 'req',
        items: [
          { id: 'phone', label: '手机', icon: 'phone' },
          { id: 'mystery', label: 'Mystery', icon: 'mystery' },
        ],
        anchor: { x: 0, y: 0, width: 16, height: 16 },
      }),
      chromeOverlayResult: () => {},
      onChromeOverlayState: () => () => {},
    }
    await act(async () => { mount() })
    const phone = screen.getByRole('menuitem', { name: '手机' })
    const svg = phone.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(phone.querySelector('rect')?.getAttribute('stroke-width')).toBe('1.3')
    expect(screen.getByRole('menuitem', { name: 'Mystery' }).querySelector('svg')).toBeNull()
  })

  it('closes a menu from the Menu onClose path', async () => {
    const result = vi.fn()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      chromeOverlayGetState: async () => ({
        kind: 'menu',
        requestId: 'req',
        items: [{ id: 'git', label: 'Git', icon: 'git' }],
        anchor: { x: 0, y: 0, width: 0, height: 0 },
      }),
      chromeOverlayResult: result,
      onChromeOverlayState: () => () => {},
    }
    await act(async () => { mount() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(result).toHaveBeenCalledWith({ type: 'close', requestId: 'req' })
  })

  it('leaves Settings requests to the sidebar settings seat', async () => {
    await act(async () => {
      ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
        chromeOverlayGetState: async () => ({
          kind: 'settings', requestId: 'set', sectionId: 'models',
        }),
        chromeOverlayResult: () => {},
        onChromeOverlayState: () => () => {},
      }
      mount()
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
