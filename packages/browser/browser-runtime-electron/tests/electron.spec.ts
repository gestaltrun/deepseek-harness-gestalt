import { describe, expect, it, vi } from 'vitest'
import { electronHostFromModule, isElectronProcess, loadElectronHost, requireElectronProcess } from '../src/electron.ts'

describe('Electron process detection', () => {
  it('requires a non-empty process.versions.electron string', () => {
    expect(isElectronProcess({ node: '22.19.0' } as NodeJS.ProcessVersions)).toBe(false)
    expect(isElectronProcess({ electron: '' } as NodeJS.ProcessVersions)).toBe(false)
    expect(isElectronProcess({ electron: '41.2.1' } as NodeJS.ProcessVersions)).toBe(true)
    expect(() => { requireElectronProcess({ node: '22.19.0' } as NodeJS.ProcessVersions) })
      .toThrow(/process.versions.electron must be set/)
  })

  it('loads BrowserWindow and session from the Electron module', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      BrowserWindow: function BrowserWindow() {},
      session: { fromPartition: () => ({}) },
    }))
    const { loadElectronHost: load } = await import('../src/electron.ts')
    const originalElectron = process.versions.electron
    Object.defineProperty(process.versions, 'electron', { value: '41.2.1', configurable: true })
    const host = await load()
    expect(typeof host.BrowserWindow).toBe('function')
    expect(typeof host.session.fromPartition).toBe('function')
    Object.defineProperty(process.versions, 'electron', { value: originalElectron, configurable: true })
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('presents pages through WebContentsView when the module exposes it', () => {
    const attached: unknown[] = []
    const captureAttached: unknown[] = []
    const contents = { destroyed: false, isDestroyed() { return this.destroyed }, close() { this.destroyed = true } }
    const order: string[] = []
    const view = {
      webContents: contents,
      bounds: undefined as { x: number; y: number; width: number; height: number } | undefined,
      visible: true,
      setBounds(bounds: { x: number; y: number; width: number; height: number }) {
        this.bounds = bounds
        order.push(`bounds:${bounds.width}x${bounds.height}`)
      },
      setVisible(visible: boolean) {
        this.visible = visible
        order.push(`visible:${String(visible)}`)
      },
    }
    function WebContentsView() { return view }
    const captureHost = {
      destroyed: false,
      shown: 0,
      contentView: {
        addChildView(next: unknown) { captureAttached.push(next) },
        removeChildView() { captureAttached.length = 0 },
      },
      isDestroyed() { return this.destroyed },
      showInactive() { this.shown += 1 },
      destroy() { this.destroyed = true },
    }
    function BaseWindow() { return captureHost }
    const parent = {
      contentView: {
        addChildView(next: unknown) { attached.push(next) },
        removeChildView() { attached.length = 0 },
      },
    }
    const host = electronHostFromModule({
      BrowserWindow: function Unused() { throw new Error('child BrowserWindow must not be used') },
      BaseWindow,
      WebContentsView,
      session: { fromPartition: () => ({}) },
    })
    const surface = new host.BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      width: 100,
      height: 80,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: 'session-test',
        offscreen: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const bounds = { x: 832, y: 76, width: 448, height: 724 }
    expect(captureAttached).toEqual([view])
    expect(captureHost.shown).toBe(1)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 100, height: 80 })
    expect(view.visible).toBe(true)
    surface.setBounds(bounds)
    surface.setParentWindow(parent)
    surface.setParentWindow(parent)
    surface.showInactive()
    expect(attached).toEqual([view])
    expect(view.bounds).toEqual(bounds)
    expect(view.visible).toBe(true)
    expect(order.lastIndexOf('bounds:448x724')).toBeLessThan(order.lastIndexOf('visible:true'))
    surface.raise()
    expect(attached).toEqual([view, view])
    surface.show()
    expect(view.visible).toBe(true)
    surface.hide()
    expect(attached).toEqual([])
    expect(captureAttached).toEqual([view])
    expect(view.visible).toBe(true)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 100, height: 80 })
    surface.setParentWindow(null)
    expect(attached).toEqual([])
    expect(surface.isDestroyed()).toBe(false)
    surface.destroy()
    expect(surface.isDestroyed()).toBe(true)
    expect(contents.destroyed).toBe(true)
    expect(captureHost.destroyed).toBe(true)
  })

  it('attaches a view that has no setVisible and ignores a parent without contentView', () => {
    const contents = { destroyed: false, isDestroyed() { return this.destroyed }, close() { this.destroyed = true } }
    const view = {
      webContents: contents,
      setBounds() {},
    }
    function WebContentsView() { return view }
    const captureHost = {
      contentView: { addChildView() {}, removeChildView() {} },
      isDestroyed: () => true,
      showInactive() {},
      destroy() {},
    }
    const parent = { contentView: { addChildView() {}, removeChildView() {} } }
    const host = electronHostFromModule({
      BrowserWindow: function BrowserWindow() { return captureHost },
      WebContentsView,
      session: { fromPartition: () => ({}) },
    })
    const surface = new host.BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      width: 10,
      height: 10,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: 'session-test',
        offscreen: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    surface.hide()
    surface.setParentWindow(parent)
    surface.raise()
    surface.show()
    surface.showInactive()
    surface.hide()
    contents.destroyed = true
    surface.destroy()
    expect(surface.isDestroyed()).toBe(true)
  })

  it('rejects a non-object Electron module export', () => {
    expect(() => { electronHostFromModule(null) }).toThrow(/did not expose BrowserWindow and session/)
    expect(() => { electronHostFromModule(7) }).toThrow(/did not expose BrowserWindow and session/)
  })

  it('rejects an Electron module that omits BrowserWindow or session', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({ BrowserWindow: undefined, session: undefined }))
    const { loadElectronHost: load } = await import('../src/electron.ts')
    const originalElectron = process.versions.electron
    Object.defineProperty(process.versions, 'electron', { value: '41.2.1', configurable: true })
    await expect(load()).rejects.toThrow(/did not expose BrowserWindow and session/)
    Object.defineProperty(process.versions, 'electron', { value: originalElectron, configurable: true })
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('loads Electron APIs from the Provider when no host is injected', async () => {
    const originalElectron = process.versions.electron
    Object.defineProperty(process.versions, 'electron', { value: '41.2.1', configurable: true })
    vi.resetModules()
    vi.doMock('electron', () => ({
      BrowserWindow: function BrowserWindow() {},
      session: { fromPartition: () => ({}) },
    }))
    const { default: Runtime } = await import('../src/index.ts')
    const { Context } = await import('@deepseek-ai/cordis')
    const ctx = new Context()
    await ctx.plugin(Runtime, { idPrefix: 'loaded' })
    const internals = ctx.browserRuntime as unknown as {
      hostApis(): Promise<{ BrowserWindow: unknown; session: { fromPartition: unknown } }>
    }
    const host = await internals.hostApis()
    expect(typeof host.BrowserWindow).toBe('function')
    expect(typeof host.session.fromPartition).toBe('function')
    await ctx.fiber.dispose()
    Object.defineProperty(process.versions, 'electron', { value: originalElectron, configurable: true })
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('refuses to import Electron on a Node process', async () => {
    const originalElectron = process.versions.electron
    Object.defineProperty(process.versions, 'electron', { value: undefined, configurable: true })
    await expect(loadElectronHost()).rejects.toThrow(/process.versions.electron must be set/)
    Object.defineProperty(process.versions, 'electron', { value: originalElectron, configurable: true })
  })
})
