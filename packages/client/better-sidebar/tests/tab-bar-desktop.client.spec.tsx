// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { overlayAnchorFromRect, TabBar, tabBarDesktopOverlayOf } from '../src/client/TabBar.tsx'

afterEach(() => {
  cleanup()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

const OPTIONS = [
  { id: 'browser', label: 'Browser' },
  { id: 'editor', label: 'Files', disabled: true },
]

function mount(onNewTab = vi.fn(), windowChrome = false) {
  return {
    onNewTab,
    ...render(
      <TabBar
        paneId="p1"
        tabs={[]}
        active={null}
        windowChrome={windowChrome}
        onActivate={() => {}}
        onClose={() => {}}
        onNewTab={onNewTab}
        newTabOptions={OPTIONS}
        onDropTab={() => {}}
      />,
    ),
  }
}

describe('overlayAnchorFromRect', () => {
  it('copies a laid-out rect and zeros a missing one', () => {
    expect(overlayAnchorFromRect(undefined)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(overlayAnchorFromRect(new DOMRect(8, 9, 24, 24))).toEqual({
      x: 8, y: 9, width: 24, height: 24,
    })
  })
})

describe('tabBarDesktopOverlayOf', () => {
  it('rejects an incomplete bridge', () => {
    expect(tabBarDesktopOverlayOf(undefined)).toBeUndefined()
    expect(tabBarDesktopOverlayOf({})).toBeUndefined()
    expect(tabBarDesktopOverlayOf({
      chromeOverlayShow: () => {},
      chromeOverlayHide: () => {},
    })).toBeUndefined()
  })
})

describe('TabBar Desktop + menu', () => {
  it('keeps window drag regions out of the browser-only Web tab bar', () => {
    mount(vi.fn(), true)
    expect(document.querySelector('[data-workbench-window-drag]')).toBeNull()
  })

  it('uses the unused Desktop top-tab space as the window drag region', () => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { platform: 'darwin' }
    mount(vi.fn(), true)
    const dragSpace = document.querySelector('[data-workbench-window-drag]')
    expect(dragSpace).not.toBeNull()
    expect(dragSpace?.nextElementSibling).toBeNull()

    const source = readFileSync(
      join(process.cwd(), 'packages/client/better-sidebar/src/client/sidebar.module.css'),
      'utf8',
    )
    const rule = /\.windowDragSpace\s*\{(?<body>[^}]+)\}/.exec(source)?.groups?.body ?? ''
    expect(rule).toContain('flex: 1')
    expect(rule).toContain('min-width: 12px')
    expect(rule).toContain('-webkit-app-region: drag')
    expect(rule).not.toContain('position: absolute')
    const tabDragRule = /body\[data-dsh-tab-dragging\] \.windowDragSpace\s*\{(?<body>[^}]+)\}/.exec(source)?.groups?.body ?? ''
    expect(tabDragRule).toContain('-webkit-app-region: no-drag')
    expect(source).not.toMatch(/\.toggleButton,\s*\.tabBar\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })

  it('opens the in-page menu when Desktop overlay verbs are absent', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /New tab|新建标签页/ }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browser' }))
  })

  it('asks the native overlay to paint the + menu and applies a select', () => {
    const show = vi.fn()
    const hide = vi.fn()
    const listeners = new Set<(result: { type: string; requestId: string; id?: string }) => void>()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      chromeOverlayShow: show,
      chromeOverlayHide: hide,
      onChromeOverlayResult: (listener: (result: { type: string; requestId: string; id?: string }) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const { onNewTab } = mount()
    const plus = screen.getByRole('button', { name: /New tab|新建标签页/ })
    plus.getBoundingClientRect = () => ({
      x: 8, y: 9, width: 24, height: 24, top: 9, left: 8, right: 32, bottom: 33, toJSON: () => ({}),
    })
    fireEvent.click(plus)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'menu',
      align: 'end',
      side: 'bottom',
      items: [
        { id: 'browser', label: 'Browser', icon: 'browser' },
        { id: 'editor', label: 'Files', disabled: true, icon: 'editor' },
      ],
      anchor: { x: 8, y: 9, width: 24, height: 24 },
    }))
    const requestId = (show.mock.calls[0]?.[0] as { requestId: string }).requestId
    act(() => {
      for (const listener of listeners) listener({ type: 'close', requestId: 'other' })
      for (const listener of listeners) listener({ type: 'select', requestId, id: 'browser' })
    })
    expect(onNewTab).toHaveBeenCalledWith('browser')
    fireEvent.click(plus)
    expect(hide).not.toHaveBeenCalled()
    fireEvent.click(plus)
    expect(hide).toHaveBeenCalledOnce()
  })

  it('closes the native overlay + menu without a select', () => {
    const show = vi.fn()
    const listeners = new Set<(result: { type: string; requestId: string; id?: string }) => void>()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      chromeOverlayShow: show,
      chromeOverlayHide: () => {},
      onChromeOverlayResult: (listener: (result: { type: string; requestId: string; id?: string }) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const { onNewTab } = mount()
    fireEvent.click(screen.getByRole('button', { name: /New tab|新建标签页/ }))
    const requestId = (show.mock.calls[0]?.[0] as { requestId: string }).requestId
    act(() => {
      for (const listener of listeners) listener({ type: 'close', requestId })
    })
    expect(onNewTab).not.toHaveBeenCalled()
  })
})
