import { Buffer } from 'node:buffer'
import type {
  ElectronBrowserWindow,
  ElectronHost,
  ElectronNativeImage,
  ElectronSession,
  ElectronWebContents,
} from '../src/electron.ts'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

export const PNG_1X1_BASE64 = PNG_1X1.toString('base64')

interface FakePage {
  url: string
  title: string
  text: string
}

interface FakeOptions {
  readonly loadDelayMs?: number
  readonly captureDelayMs?: number
  readonly captureEmpty?: boolean
  readonly captureFailures?: number
  readonly captureFailureMessage?: string
  readonly crashOnLoad?: boolean
  readonly failLoad?: boolean | 'primitive' | 'null' | 'net' | 'net-chrome-error'
  /** Reject loadURL with ERR_ABORTED after committing the requested URL. */
  readonly abortLoadThenCommit?: boolean | 'errno' | 'message'
  readonly failExecute?: boolean
  readonly executeNonString?: boolean
  readonly failFlush?: boolean
  readonly failClear?: boolean
  readonly focusedEditable?: boolean
}

function titleFor(url: string): string {
  if (url === 'about:blank') return 'New Tab'
  if (url === 'https://example.test/') return 'Example Domain'
  if (url === 'https://login.test/') return 'Sign in'
  return 'Loaded page'
}

function textFor(url: string, identity: string): string {
  if (url === 'about:blank') return identity.length === 0 ? '' : `identity=${identity}`
  if (url === 'https://example.test/') {
    return identity.length === 0 ? 'An Electron protocol page.' : `An Electron protocol page.\nidentity=${identity}`
  }
  if (url === 'https://login.test/') return `Signed in as ${identity}.\nidentity=${identity}`
  return identity.length === 0 ? 'Loaded page text.' : `Loaded page text.\nidentity=${identity}`
}

function identityFrom(partition: string): string {
  if (partition.includes('-tmp-')) return ''
  const marker = partition.lastIndexOf('-')
  return marker === -1 ? partition : partition.slice(marker + 1)
}

class FakeNativeImage implements ElectronNativeImage {
  constructor(private readonly bytes: Uint8Array) {}
  toPNG(): Uint8Array {
    return this.bytes
  }
}

class FakeSession implements ElectronSession {
  flushed = 0
  cleared = 0
  constructor(
    readonly partition: string,
    private readonly options: FakeOptions,
  ) {}
  async flushStorageData(): Promise<void> {
    if (this.options.failFlush === true) throw new Error('flush failed')
    this.flushed += 1
  }
  async clearStorageData(): Promise<void> {
    if (this.options.failClear === true) throw new Error('clear failed')
    this.cleared += 1
  }
}

class FakeWebContents implements ElectronWebContents {
  private href = 'about:blank'
  private heading = 'New Tab'
  destroyed = false
  focused = false
  stopped = false
  captureAttempts = 0
  readonly inputEvents: string[] = []
  private loadWait: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  constructor(
    readonly session: FakeSession,
    private readonly page: FakePage,
    private readonly options: FakeOptions,
  ) {}
  getURL(): string {
    return this.href
  }
  getTitle(): string {
    return this.heading
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  stop(): void {
    this.stopped = true
    this.loadWait?.()
  }
  async loadURL(url: string): Promise<void> {
    if (this.options.failLoad === true) throw new Error('load failed')
    if (this.options.failLoad === 'primitive' && url !== 'about:blank') throw 3
    if (this.options.failLoad === 'null' && url !== 'about:blank') throw null
    if ((this.options.failLoad === 'net' || this.options.failLoad === 'net-chrome-error') && url !== 'about:blank') {
      if (this.options.failLoad === 'net-chrome-error') {
        this.href = 'chrome-error://chromewebdata/'
        this.heading = ''
        this.page.url = this.href
        this.page.title = ''
        this.page.text = ''
      } else {
        this.href = url
        this.heading = titleFor(url)
        this.page.url = url
        this.page.title = this.heading
        this.page.text = ''
      }
      const error = new Error(`ERR_CONNECTION_CLOSED (-100) loading '${url}'`) as Error & {
        code: string
        errno: number
      }
      error.code = 'ERR_CONNECTION_CLOSED'
      error.errno = -100
      throw error
    }
    if (this.options.abortLoadThenCommit !== undefined && this.options.abortLoadThenCommit !== false && url !== 'about:blank') {
      const identity = identityFrom(this.session.partition)
      this.href = `${url}${url.includes('?') ? '&' : '?'}sei=1`
      this.heading = titleFor(url)
      this.page.url = this.href
      this.page.title = this.heading
      this.page.text = textFor(url, identity)
      const kind = this.options.abortLoadThenCommit
      if (kind === 'errno') {
        throw Object.assign(new Error('redirected'), { errno: -3 })
      }
      if (kind === 'message') {
        throw new Error(`ERR_ABORTED (-3) loading '${this.href}'`)
      }
      const error = new Error(`ERR_ABORTED (-3) loading '${this.href}'`) as Error & { code: string; errno: number }
      error.code = 'ERR_ABORTED'
      error.errno = -3
      throw error
    }
    if (this.options.loadDelayMs !== undefined && url !== 'about:blank') {
      await new Promise<void>((resolve) => {
        this.loadWait = resolve
        setTimeout(resolve, this.options.loadDelayMs)
      })
      this.loadWait = undefined
    }
    const identity = identityFrom(this.session.partition)
    this.href = url
    this.heading = titleFor(url)
    this.page.url = url
    this.page.title = this.heading
    this.page.text = textFor(url, identity)
    if (this.options.crashOnLoad === true) this.emitCrash()
  }
  focus(): void {
    this.focused = true
  }
  sendInputEvent(event: { readonly type: 'char'; readonly keyCode: string }): void {
    this.inputEvents.push(event.keyCode)
    this.page.text += event.keyCode
  }
  async capturePage(): Promise<ElectronNativeImage> {
    this.captureAttempts += 1
    if (this.captureAttempts <= (this.options.captureFailures ?? 0)) {
      throw new Error(this.options.captureFailureMessage ?? 'UnknownVizError')
    }
    if (this.options.captureDelayMs !== undefined) {
      await new Promise(resolve => setTimeout(resolve, this.options.captureDelayMs))
    }
    if (this.options.captureEmpty === true) return new FakeNativeImage(new Uint8Array())
    return new FakeNativeImage(PNG_1X1)
  }
  async executeJavaScript(code?: string): Promise<unknown> {
    if (this.options.failExecute === true) throw new Error('execute failed')
    if (this.options.executeNonString === true) return 7
    if (typeof code === 'string' && code.includes('selectionStart')) {
      const call = code.lastIndexOf(')(')
      if (call !== -1 && code.endsWith(')')) {
        try {
          const text = JSON.parse(code.slice(call + 2, -1)) as unknown
          if (typeof text === 'string') this.page.text += text
        } catch {
          // The insert script is invoked as (`script`)(`json`); anything else is not text.
        }
      }
      return undefined
    }
    if (typeof code === 'string' && code.includes('isContentEditable')) {
      return this.options.focusedEditable === true
    }
    return this.page.text
  }
  close(): void {
    this.destroyed = true
  }
  on(event: 'render-process-gone', listener: () => void): this {
    if (event === 'render-process-gone') this.listeners.add(listener)
    return this
  }
  off(event: 'render-process-gone', listener: () => void): this {
    if (event === 'render-process-gone') this.listeners.delete(listener)
    return this
  }
  emitCrash(): void {
    for (const listener of [...this.listeners]) listener()
  }
  windowOpenHandler: ((details: { readonly url: string }) => { readonly action: 'allow' | 'deny' }) | undefined
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => { readonly action: 'allow' | 'deny' },
  ): void {
    this.windowOpenHandler = handler
  }
}

class FakeBrowserWindow implements ElectronBrowserWindow {
  destroyed = false
  shown = false
  showInactiveCalls = 0
  raiseCalls = 0
  parent: unknown = null
  bounds: { x: number; y: number; width: number; height: number } | undefined
  readonly webContents: FakeWebContents
  constructor(webContents: FakeWebContents) {
    this.webContents = webContents
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }
  show(): void {
    this.shown = true
  }
  showInactive(): void {
    this.shown = true
    this.showInactiveCalls += 1
  }
  hide(): void {
    this.shown = false
  }
  setParentWindow(parent: unknown): void {
    this.parent = parent
  }
  raise(): void {
    this.raiseCalls += 1
  }
  destroy(): void {
    this.destroyed = true
    this.webContents.destroyed = true
  }
}

function createBrowserWindow(
  host: FakeElectronHost,
  windowOptions: { readonly webPreferences: { readonly partition: string } },
): FakeBrowserWindow {
  const session = host.session.fromPartition(windowOptions.webPreferences.partition) as FakeSession
  const page: FakePage = { url: 'about:blank', title: 'New Tab', text: '' }
  const contents = new FakeWebContents(session, page, host.options)
  const window = new FakeBrowserWindow(contents)
  host.windows.push(window)
  return window
}

/** In-memory Electron APIs that never spawn Chromium or Tandem. */
export class FakeElectronHost implements ElectronHost {
  readonly sessions = new Map<string, FakeSession>()
  readonly windows: FakeBrowserWindow[] = []
  readonly BrowserWindow: ElectronHost['BrowserWindow']
  constructor(readonly options: FakeOptions = {}) {
    const create = (windowOptions: { readonly webPreferences: { readonly partition: string } }): FakeBrowserWindow =>
      createBrowserWindow(this, windowOptions)
    this.BrowserWindow = function BrowserWindow(this: unknown, windowOptions: { readonly webPreferences: { readonly partition: string } }) {
      return create(windowOptions)
    } as unknown as ElectronHost['BrowserWindow']
  }
  readonly session = {
    fromPartition: (partition: string): ElectronSession => {
      const existing = this.sessions.get(partition)
      if (existing !== undefined) return existing
      const created = new FakeSession(partition, this.options)
      this.sessions.set(partition, created)
      return created
    },
  }
}
