import { describe, expect, it, vi } from 'vitest'
import {
  hideChromeOverlayView, isOverlaySender, overlayBoundsFromContentSize, overlayUrlFromHost,
  parseChromeOverlayResult, parseChromeOverlayShow, prepareChromeOverlayView,
  showChromeOverlayView, syncChromeOverlayBounds,
} from '../src/chrome-overlay.ts'

describe('chrome overlay helpers', () => {
  it('stamps the overlay query on a host URL', () => {
    expect(overlayUrlFromHost('http://127.0.0.1:58463/')).toBe(
      'http://127.0.0.1:58463/?dsh-desktop-overlay=1',
    )
  })

  it('sizes a full-window overlay and rejects a tiny content box', () => {
    expect(overlayBoundsFromContentSize([1280, 800])).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(overlayBoundsFromContentSize([7, 800])).toBeUndefined()
    expect(overlayBoundsFromContentSize(['x'] as never)).toBeUndefined()
    expect(overlayBoundsFromContentSize([])).toBeUndefined()
  })

  it('prepares, shows, syncs, and hides a view', () => {
    const view = {
      setBackgroundColor: vi.fn(),
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: { focus: vi.fn(), send: vi.fn() },
    }
    const addChildView = vi.fn()
    const window = { contentView: { addChildView }, getContentSize: () => [640, 480] }
    prepareChromeOverlayView(view)
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    expect(view.setVisible).toHaveBeenCalledWith(false)
    showChromeOverlayView(window, view)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 640, height: 480 })
    expect(view.setVisible).toHaveBeenCalledWith(true)
    expect(addChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.focus).toHaveBeenCalledOnce()
    syncChromeOverlayBounds({ getContentSize: () => [8, 8] }, view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 8, height: 8 })
    hideChromeOverlayView(view)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    showChromeOverlayView({ getContentSize: () => [1, 1] }, {})
    syncChromeOverlayBounds({}, {})
    prepareChromeOverlayView({})
    hideChromeOverlayView({})
  })

  it('parses settings and menu overlay requests', () => {
    expect(parseChromeOverlayShow(null)).toBeUndefined()
    expect(parseChromeOverlayShow({ kind: 'settings' })).toBeUndefined()
    expect(parseChromeOverlayShow({ kind: 'other', requestId: 'r' })).toBeUndefined()
    expect(parseChromeOverlayShow({ kind: 'settings', requestId: 'r', sectionId: '' })).toBeUndefined()
    expect(parseChromeOverlayShow({ kind: 'settings', requestId: 'r' })).toEqual({
      kind: 'settings', requestId: 'r',
    })
    expect(parseChromeOverlayShow({ kind: 'settings', requestId: 'r', sectionId: 'models' })).toEqual({
      kind: 'settings', requestId: 'r', sectionId: 'models',
    })
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: 'nope', anchor: { x: 1, y: 2, width: 3, height: 4 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: [{}], anchor: { x: 1, y: 2, width: 3, height: 4 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'browser', label: 'Browser', disabled: 'yes' }],
      anchor: { x: 1, y: 2, width: 3, height: 4 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'browser', label: 'Browser', icon: '' }],
      anchor: { x: 1, y: 2, width: 3, height: 4 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: [], anchor: { x: 1, y: 2, width: -1, height: 4 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: [], anchor: { x: 1, y: 2, width: 3, height: 4 }, align: 'mid',
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: [], anchor: { x: 1, y: 2, width: 3, height: 4 }, side: 'left',
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'browser', label: 'Browser', disabled: true, icon: 'browser' }],
      anchor: { x: 1, y: 2, width: 3, height: 4 },
      align: 'end',
      side: 'bottom',
    })).toEqual({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'browser', label: 'Browser', disabled: true, icon: 'browser' }],
      anchor: { x: 1, y: 2, width: 3, height: 4 },
      align: 'end',
      side: 'bottom',
    })
    expect(parseChromeOverlayShow({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'editor', label: 'Files' }],
      anchor: { x: 0, y: 0, width: 0, height: 0 },
      align: 'start',
      side: 'top',
    })).toEqual({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'editor', label: 'Files' }],
      anchor: { x: 0, y: 0, width: 0, height: 0 },
      align: 'start',
      side: 'top',
    })
    expect(parseChromeOverlayShow({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'git', label: 'Git' }],
      anchor: { x: 1, y: 2, width: 3, height: 4 },
      side: 'right',
    })).toEqual({
      kind: 'menu',
      requestId: 'r',
      items: [{ id: 'git', label: 'Git' }],
      anchor: { x: 1, y: 2, width: 3, height: 4 },
      side: 'right',
    })
    const tooMany = Array.from({ length: 33 }, (_, i) => ({ id: `i${String(i)}`, label: 'x' }))
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: tooMany, anchor: { x: 0, y: 0, width: 1, height: 1 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: ['x'], anchor: { x: 0, y: 0, width: 1, height: 1 },
    })).toBeUndefined()
    expect(parseChromeOverlayShow({
      kind: 'menu', requestId: 'r', items: [], anchor: null,
    })).toBeUndefined()
  })

  it('parses overlay replies and sender identity', () => {
    expect(parseChromeOverlayResult(null)).toBeUndefined()
    expect(parseChromeOverlayResult({ type: 'close' })).toBeUndefined()
    expect(parseChromeOverlayResult({ type: 'other', requestId: 'r' })).toBeUndefined()
    expect(parseChromeOverlayResult({ type: 'select', requestId: 'r' })).toBeUndefined()
    expect(parseChromeOverlayResult({ type: 'close', requestId: 'r' })).toEqual({ type: 'close', requestId: 'r' })
    expect(parseChromeOverlayResult({ type: 'select', requestId: 'r', id: 'browser' })).toEqual({
      type: 'select', requestId: 'r', id: 'browser',
    })
    expect(isOverlaySender(3, 3)).toBe(true)
    expect(isOverlaySender(3, 4)).toBe(false)
    expect(isOverlaySender(3, undefined)).toBe(false)
  })
})
