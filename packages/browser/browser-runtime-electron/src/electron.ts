/**
 * Narrow Electron APIs used by the in-process Browser Runtime.
 * @module @deepseek-ai/dsh-browser-runtime-electron/electron
 */

/** Pixel buffer returned by `webContents.capturePage`. */
export interface ElectronNativeImage {
  /** Encode the captured page as PNG bytes. */
  toPNG(): Uint8Array
}

/** Isolated Chromium session that backs one persist or ephemeral partition. */
export interface ElectronSession {
  /** Persist cookies, cache, and service-worker state for a named Profile. */
  flushStorageData(): Promise<void>
  /** Clear ephemeral partition state when a temporary Profile closes. */
  clearStorageData(): Promise<void>
}

/** Hidden page used for navigation, observation, and screenshots. */
export interface ElectronWebContents {
  /** Current document URL, including `about:blank`. */
  getURL(): string
  /** Document title reported by Chromium. */
  getTitle(): string
  /** Isolated session that owns this page. */
  readonly session: ElectronSession
  /** True after Chromium destroyed the contents. */
  isDestroyed(): boolean
  /** Navigate and resolve after the first successful document load. */
  loadURL(url: string): Promise<void>
  /** Stop in-flight navigation or script so abort and timeout can reach quiescence. */
  stop(): void
  /** Focus the hidden contents so later Agent mutations address it. */
  focus(): void
  /** Deliver one synthetic Agent input event into the hidden contents. */
  sendInputEvent(event: { readonly type: 'char'; readonly keyCode: string }): void
  /** Capture the current page as a PNG. */
  capturePage(): Promise<ElectronNativeImage>
  /** Read model-visible page text from the isolated world. */
  executeJavaScript(code: string): Promise<unknown>
  /** Destroy the hidden contents. */
  close(): void
  /** Observe renderer-process loss. */
  on(event: 'render-process-gone', listener: () => void): this
  /** Remove one renderer-process-loss listener. */
  off(event: 'render-process-gone', listener: () => void): this
  /**
   * Decide what happens when the page calls `window.open`.
   * Desktop denies a second native window and loads the URL in this page.
   */
  setWindowOpenHandler?(handler: (details: { readonly url: string }) => { readonly action: 'allow' | 'deny' }): void
}

/** Rectangle used to present one page over the Desktop sidebar viewport. */
export interface ElectronWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Hidden BrowserWindow that owns one page `webContents`. */
export interface ElectronBrowserWindow {
  /** Page this window owns. */
  readonly webContents: ElectronWebContents
  /** True after the window was destroyed. */
  isDestroyed(): boolean
  /** Place the page in content-relative DIP coordinates. */
  setBounds(bounds: ElectronWindowBounds): void
  /** Show and activate. Desktop present must not use this. */
  show(): void
  /** Show in the Host content view without activating the Host. */
  showInactive(): void
  /** Hide the page when another tab is active or the panel closes. */
  hide(): void
  /** Attach the page to the Host `contentView`, or detach when `parent` is null. */
  setParentWindow(parent: unknown): void
  /** Put this page above Host chrome after an overlay closes. */
  raise(): void
  /** Destroy the hidden window and its contents. */
  destroy(): void
}

/** Options for one page window that can stay hidden or present live. */
export interface ElectronBrowserWindowOptions {
  /** Keep the window hidden until Desktop presents it. */
  readonly show: false
  /** No native chrome; Desktop supplies address bar and tabs. */
  readonly frame: false
  /** Keep the page out of the operating-system task switcher. */
  readonly skipTaskbar: true
  /** No native shadow around the sidebar viewport. */
  readonly hasShadow: false
  /** Square corners so the page sits flush in the sidebar hole. */
  readonly roundedCorners: false
  /** Capture width in CSS pixels while hidden. */
  readonly width: number
  /** Capture height in CSS pixels while hidden. */
  readonly height: number
  /** Paint the first frame before the window is shown. */
  readonly paintWhenInitiallyHidden: true
  /** Isolated Chromium preferences for this window. */
  readonly webPreferences: {
    /** Persist or ephemeral partition key. */
    readonly partition: string
    /** Live input requires a real window, not an offscreen surface. */
    readonly offscreen: false
    /** Sandbox the renderer. */
    readonly sandbox: true
    /** Isolate the renderer world. */
    readonly contextIsolation: true
    /** Keep Node APIs out of the page. */
    readonly nodeIntegration: false
    /** Keep hidden pages painting. */
    readonly backgroundThrottling: false
  }
}

/** Constructor for one hidden offscreen window. */
export type ElectronBrowserWindowConstructor = new (options: ElectronBrowserWindowOptions) => ElectronBrowserWindow

/** Electron `session` module used to isolate persist and ephemeral partitions. */
export interface ElectronSessionModule {
  /** Create or reuse the Chromium session for one partition string. */
  fromPartition(partition: string): ElectronSession
}

/** Electron APIs required by this Provider. */
export interface ElectronHost {
  /** Hidden-window constructor. */
  readonly BrowserWindow: ElectronBrowserWindowConstructor
  /** Partitioned session factory. */
  readonly session: ElectronSessionModule
}

/**
 * True when this process is Electron rather than Node.
 * @param versions - Process version map to inspect.
 * @returns whether `versions.electron` is a non-empty string.
 */
export function isElectronProcess(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return typeof versions.electron === 'string' && versions.electron.length > 0
}

/**
 * Reject composition on a Node process that is not Electron.
 * @param versions - Process version map to inspect.
 */
export function requireElectronProcess(versions: NodeJS.ProcessVersions = process.versions): void {
  if (!isElectronProcess(versions)) {
    throw new Error('browser-runtime-electron: process.versions.electron must be set; this Provider loads only inside Electron')
  }
}

/**
 * Validate one imported Electron module as BrowserWindow and session factories.
 * @param loaded - Value returned by `import('electron')`.
 * @returns BrowserWindow and session factories from that module.
 */
export function electronHostFromModule(loaded: unknown): ElectronHost {
  if (typeof loaded !== 'object' || loaded === null) {
    throw new Error('browser-runtime-electron: the Electron module did not expose BrowserWindow and session')
  }
  const record = loaded as Record<string, unknown>
  const browserWindow = record.BrowserWindow
  const session = record.session
  if (typeof browserWindow !== 'function' || session === undefined) {
    throw new Error('browser-runtime-electron: the Electron module did not expose BrowserWindow and session')
  }
  let view: unknown
  let baseWindow: unknown
  try {
    view = record.WebContentsView
    baseWindow = record.BaseWindow
  } catch {
    // Vitest electron mocks throw when reading an undeclared named export.
    view = undefined
    baseWindow = undefined
  }
  return {
    BrowserWindow: typeof view === 'function'
      ? pageSurfaceFromView(
        view as ElectronWebContentsViewConstructor,
        (typeof baseWindow === 'function' ? baseWindow : browserWindow) as ElectronViewHostConstructor,
      )
      : browserWindow as ElectronBrowserWindowConstructor,
    session: session as ElectronSessionModule,
  }
}

/** Electron `WebContentsView` constructor used instead of a child `BrowserWindow`. */
type ElectronWebContentsViewConstructor = new (options: {
  readonly webPreferences: ElectronBrowserWindowOptions['webPreferences']
}) => ElectronWebContentsView

/** One page view that can sit in the Host `contentView`. */
interface ElectronWebContentsView {
  readonly webContents: ElectronWebContents
  setBounds(bounds: ElectronWindowBounds): void
  setVisible?(visible: boolean): void
}

/** Host window `contentView` verbs used to attach one page. */
interface ElectronParentContentView {
  addChildView(view: ElectronWebContentsView): void
  removeChildView(view: ElectronWebContentsView): void
}

/** Hidden native window that keeps an unattached page view painting. */
interface ElectronViewHost {
  readonly contentView: ElectronParentContentView
  isDestroyed(): boolean
  showInactive(): void
  destroy(): void
}

/** Constructor for the hidden page-view paint host. */
type ElectronViewHostConstructor = new (options: {
  readonly show: false
  readonly frame: false
  readonly skipTaskbar: true
  readonly focusable: false
  readonly hasShadow: false
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly opacity: number
}) => ElectronViewHost

/**
 * Adapt `WebContentsView` to the page-surface verbs the Runtime already calls.
 * A child `BrowserWindow` plus `setParentWindow` SIGSEGV on macOS Electron 41.
 * @param View - Electron `WebContentsView` constructor.
 * @returns a constructor the Runtime can `new` in place of `BrowserWindow`.
 */
function pageSurfaceFromView(
  View: ElectronWebContentsViewConstructor,
  Host: ElectronViewHostConstructor,
): ElectronBrowserWindowConstructor {
  return class PageSurface implements ElectronBrowserWindow {
    readonly webContents: ElectronWebContents
    private readonly view: ElectronWebContentsView
    private readonly captureHost: ElectronViewHost
    private readonly captureBounds: ElectronWindowBounds
    private parent: { contentView?: ElectronParentContentView }
    private pending: ElectronWindowBounds | undefined
    private destroyed = false

    constructor(options: ElectronBrowserWindowOptions) {
      this.captureBounds = { x: 0, y: 0, width: options.width, height: options.height }
      this.captureHost = new Host({
        show: false,
        frame: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        x: -10_000,
        y: -10_000,
        width: options.width,
        height: options.height,
        opacity: 0,
      })
      this.parent = this.captureHost
      this.view = new View({ webPreferences: options.webPreferences })
      this.webContents = this.view.webContents
      this.captureHost.contentView.addChildView(this.view)
      this.view.setBounds(this.captureBounds)
      this.view.setVisible?.(true)
      this.captureHost.showInactive()
    }

    isDestroyed(): boolean {
      return this.destroyed || this.webContents.isDestroyed()
    }

    setBounds(bounds: ElectronWindowBounds): void {
      this.pending = bounds
      this.view.setBounds(bounds)
    }

    show(): void {
      if (this.pending !== undefined) this.view.setBounds(this.pending)
      this.view.setVisible?.(true)
    }

    showInactive(): void {
      if (this.pending !== undefined) this.view.setBounds(this.pending)
      this.view.setVisible?.(true)
    }

    hide(): void {
      if (this.parent !== this.captureHost) {
        this.detach()
        this.parent = this.captureHost
        this.attach()
      }
      this.view.setBounds(this.captureBounds)
      this.view.setVisible?.(true)
    }

    setParentWindow(parent: unknown): void {
      const requested = parent as { contentView?: ElectronParentContentView } | null
      const next = requested?.contentView === undefined ? this.captureHost : requested
      if (next === this.parent) return
      this.detach()
      this.parent = next
      this.attach()
    }

    raise(): void {
      this.parent.contentView?.addChildView(this.view)
    }

    destroy(): void {
      this.detach()
      this.destroyed = true
      if (!this.webContents.isDestroyed()) this.webContents.close()
      if (!this.captureHost.isDestroyed()) this.captureHost.destroy()
    }

    private attach(): void {
      const bounds = this.parent === this.captureHost ? this.captureBounds : this.pending
      if (bounds !== undefined) this.view.setBounds(bounds)
      this.parent.contentView?.addChildView(this.view)
      if (bounds !== undefined) this.view.setBounds(bounds)
    }

    private detach(): void {
      this.parent.contentView?.removeChildView(this.view)
    }
  }
}

/**
 * Load the in-process Electron APIs or fail loud.
 * @returns BrowserWindow and session factories from this Electron process.
 */
export async function loadElectronHost(): Promise<ElectronHost> {
  requireElectronProcess()
  return electronHostFromModule(await import('electron'))
}
