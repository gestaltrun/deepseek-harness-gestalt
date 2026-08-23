// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import { desktopPageSurfaceOf, presentablePageBounds, useDesktopPageSurface } from '../src/client/desktop-page-surface.ts'

const OriginalResizeObserver = globalThis.ResizeObserver

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
  document.documentElement.removeAttribute('data-dsh-desktop-overlay')
  globalThis.ResizeObserver = OriginalResizeObserver
})

const TARGET = {
  profileId: 'p',
  workspaceId: 'w',
  browserId: 'b',
  tabId: 't',
} as BrowserTarget

function Probe(props: { target?: BrowserTarget; enabled: boolean }) {
  const viewport = useDesktopPageSurface(props.target, props.enabled)
  return <div ref={viewport} data-testid="hole" />
}

function NoNode(props: { target: BrowserTarget; enabled: boolean }) {
  useDesktopPageSurface(props.target, props.enabled)
  return null
}

describe('desktop page surface', () => {
  it('ignores a bridge without present verbs', () => {
    expect(desktopPageSurfaceOf(undefined)).toBeUndefined()
    expect(desktopPageSurfaceOf({})).toBeUndefined()
    expect(desktopPageSurfaceOf({ browserPresent: () => {} })).toBeUndefined()
  })

  it('presents a sized viewport and conceals on disable', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    const verbs = { browserPresent: present, browserConceal: conceal }
    expect(desktopPageSurfaceOf(verbs)).toBe(verbs)
    const observed: Element[] = []
    class FakeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observed.push(target)
        this.callback([] as never, this)
      }
      disconnect(): void {
        observed.length = 0
      }
      unobserve(): void {}
    }
    globalThis.ResizeObserver = FakeObserver
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = verbs
    const view = render(<Probe target={TARGET} enabled={true} />)
    const hole = view.getByTestId('hole')
    hole.getBoundingClientRect = () => ({
      x: 12, y: 24, width: 640, height: 400, top: 24, left: 12, right: 652, bottom: 424, toJSON: () => ({}),
    })
    window.dispatchEvent(new Event('resize'))
    expect(present).toHaveBeenCalledWith({
      target: TARGET,
      bounds: { x: 12, y: 24, width: 640, height: 400 },
    })
    view.rerender(<Probe target={TARGET} enabled={false} />)
    expect(conceal).toHaveBeenCalledWith(TARGET)
    expect(observed).toHaveLength(0)
  })

  it('does nothing when the viewport element is absent', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    render(<NoNode target={TARGET} enabled={true} />)
    expect(present).not.toHaveBeenCalled()
    expect(conceal).not.toHaveBeenCalled()
  })

  it('does not conceal when create is still in flight', () => {
    const conceal = vi.fn()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      browserPresent: vi.fn(),
      browserConceal: conceal,
    }
    render(<Probe enabled={true} />)
    expect(conceal).not.toHaveBeenCalled()
  })

  it('does not tear the surface down when only the target object identity changes', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    const view = render(<Probe target={TARGET} enabled={true} />)
    expect(conceal).toHaveBeenCalledTimes(1)
    view.rerender(<Probe target={{ ...TARGET }} enabled={true} />)
    expect(conceal).toHaveBeenCalledTimes(1)
    expect(present).not.toHaveBeenCalled()
  })

  it('does not re-present identical rounded bounds', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    class FakeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        this.callback([] as never, this)
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = FakeObserver
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    const view = render(<Probe target={TARGET} enabled={true} />)
    const hole = view.getByTestId('hole')
    hole.getBoundingClientRect = () => ({
      x: 12.4, y: 24.6, width: 640.2, height: 400.1, top: 24, left: 12, right: 652, bottom: 424, toJSON: () => ({}),
    })
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(present).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenCalledWith({
      target: TARGET,
      bounds: { x: 12, y: 25, width: 640, height: 400 },
    })
    expect(conceal).toHaveBeenCalled()
  })

  it('presents when ResizeObserver is missing', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    const view = render(<Probe target={TARGET} enabled={true} />)
    const hole = view.getByTestId('hole')
    hole.getBoundingClientRect = () => ({
      x: 12, y: 24, width: 640, height: 400, top: 24, left: 12, right: 652, bottom: 424, toJSON: () => ({}),
    })
    window.dispatchEvent(new Event('resize'))
    expect(present).toHaveBeenCalledWith({
      target: TARGET,
      bounds: { x: 12, y: 24, width: 640, height: 400 },
    })
  })

  it('presents when location is missing and the overlay attribute is absent', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    vi.stubGlobal('location', undefined)
    class FakeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(_target: Element): void {
        this.callback([] as never, this)
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = FakeObserver
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    const view = render(<Probe target={TARGET} enabled={true} />)
    const hole = view.getByTestId('hole')
    hole.getBoundingClientRect = () => ({
      x: 12, y: 24, width: 640, height: 400, top: 24, left: 12, right: 652, bottom: 424, toJSON: () => ({}),
    })
    window.dispatchEvent(new Event('resize'))
    expect(present).toHaveBeenCalledWith({
      target: TARGET,
      bounds: { x: 12, y: 24, width: 640, height: 400 },
    })
  })

  it('does not present or conceal in the Desktop overlay document', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    render(<Probe target={TARGET} enabled={true} />)
    expect(present).not.toHaveBeenCalled()
    expect(conceal).not.toHaveBeenCalled()
    cleanup()
    document.documentElement.removeAttribute('data-dsh-desktop-overlay')
    vi.stubGlobal('location', { search: '?dsh-desktop-overlay=1' })
    render(<Probe target={TARGET} enabled={true} />)
    expect(present).not.toHaveBeenCalled()
    expect(conceal).not.toHaveBeenCalled()
  })

  it('computes presentable bounds for a usable hole', () => {
    const hole = { x: 10, y: 20, width: 100, height: 200, top: 20, left: 10, right: 110, bottom: 220, toJSON: () => ({}) }
    expect(presentablePageBounds({ ...hole, width: 4, height: 200, right: 14 })).toBeUndefined()
    expect(presentablePageBounds(hole)).toEqual({ x: 10, y: 20, width: 100, height: 200 })
  })

  it('conceals when the viewport is too small', () => {
    const present = vi.fn()
    const conceal = vi.fn()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { browserPresent: present, browserConceal: conceal }
    render(<Probe target={TARGET} enabled={true} />)
    expect(conceal).toHaveBeenCalledWith(TARGET)
    expect(present).not.toHaveBeenCalled()
  })
})
