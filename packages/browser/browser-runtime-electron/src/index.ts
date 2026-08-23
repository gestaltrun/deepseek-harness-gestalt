/**
 * In-process Electron Browser Runtime for temporary, named persistent, and shared Profiles.
 * @module @deepseek-ai/dsh-browser-runtime-electron
 */

/* jscpd:ignore-start */
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  addressedBrowserRuntimeStateFrom,
  assertBrowserCreateAttach,
  assertBrowserNotAborted,
  assertUnattachedPersistentWriterAvailable,
  BrowserRuntime,
  BrowserRuntimeError,
  browserTargetFor,
  browserTargetKey,
  commitBrowserRuntimeState,
  emitBrowserRuntimeState,
  EMPTY_BROWSER_PROFILE_STORAGE,
  requireExpectedBrowserRevision,
  resolveBrowserCreateAttach,
  resolveBrowserProfileCreate,
  browserProfileRetainsIdentity,
  browserSharedWorkspaceSeq,
} from '@deepseek-ai/dsh-browser-runtime'
import type {
  BrowserClosedState,
  BrowserCreateRequest,
  BrowserInputRequest,
  BrowserMutationRequest,
  BrowserNavigateRequest,
  BrowserObserveRequest,
  BrowserPageState,
  BrowserProfileChrome,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
} from '@deepseek-ai/dsh-browser-runtime'
/* jscpd:ignore-end */
import {
  isElectronProcess,
  loadElectronHost,
  type ElectronBrowserWindow,
  type ElectronHost,
  type ElectronSession,
  type ElectronWindowBounds,
} from './electron.ts'
import { electronTestHost } from './host-seam.ts'
import {
  ELECTRON_RUNTIME_STATE_OWNER,
  electronRuntimeStateValidator,
  registerElectronRuntimeStateReader,
  type ElectronRuntimeStateOwner,
} from './runtime-state.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const PAGE_TEXT_SCRIPT = `(() => {
  const root = document.body ?? document.documentElement
  return root === null ? '' : (root.innerText ?? '')
})()`
const NEXT_ANIMATION_FRAME_SCRIPT = 'new Promise(resolve => requestAnimationFrame(() => resolve()))'
const FOCUSED_EDITABLE_SCRIPT = `(() => {
  const active = document.activeElement
  return active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || (active instanceof HTMLElement && active.isContentEditable)
})()`
const INSERT_TEXT_SCRIPT = `(text) => {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? active.value.length
    const end = active.selectionEnd ?? active.value.length
    active.value = active.value.slice(0, start) + text + active.value.slice(end)
    const cursor = start + text.length
    active.setSelectionRange(cursor, cursor)
    active.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    active.textContent = (active.textContent ?? '') + text
    return
  }
}`

function sameWindowBounds(left: ElectronWindowBounds, right: ElectronWindowBounds): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}

/** True when Chromium aborted a loadURL because a later navigation superseded it. */
function isAbortedNavigation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; errno?: unknown; message?: unknown }
  if (record.code === 'ERR_ABORTED' || record.errno === -3) return true
  return typeof record.message === 'string' && record.message.includes('ERR_ABORTED')
}

/** True when Chromium has not created the hidden page's first Viz surface yet. */
function isTransientCaptureError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'message') === 'UnknownVizError'
}

const CHROMIUM_NET_ERROR = /\bERR_[A-Z0-9_]+\b/

/** True when loadURL rejected after Chromium committed a net-error document. */
function isCommittedLoadError(error: unknown): boolean {
  if (isAbortedNavigation(error)) return true
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; message?: unknown }
  if (typeof record.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(record.code)) return true
  return typeof record.message === 'string' && CHROMIUM_NET_ERROR.test(record.message)
}

/** True when Chromium replaced the address with its interstitial error document. */
function isChromeErrorUrl(url: string): boolean {
  return url.startsWith('chrome-error:')
}

/**
 * Address-bar URL after a committed load.
 * Chromium may report `chrome-error:` while the requested URL stays in the bar.
 */
function pageDisplayUrl(observed: string, fallback: string): string {
  if (observed === '' || isChromeErrorUrl(observed)) return fallback
  return observed
}

/** Process and lifecycle configuration for one in-process Electron runtime. */
export interface Config {
  /** Prefix for DSH-owned opaque Profile, Workspace, and browser identities. */
  idPrefix?: string
  /** Hidden window width used for capture while the page is not presented. */
  viewportWidth?: number
  /** Hidden window height used for capture while the page is not presented. */
  viewportHeight?: number
  /** Bound on each Chromium navigation or content read. */
  requestTimeoutMs?: number
}

/** Runtime configuration schema for the in-process Electron Browser Provider. */
export const Config: z<Config> = z.object({
  idPrefix: z.string().default('electron'),
  viewportWidth: z.number().default(1280),
  viewportHeight: z.number().default(800),
  requestTimeoutMs: z.number().default(30_000),
})

type ResolvedConfig = Required<Config>

/** One open Electron Profile lifecycle owned by this Provider. */
interface OpenProfile {
  readonly sessionName: string
  readonly chrome: BrowserProfileChrome
  readonly session: ElectronSession
  readonly tabs: Map<string, OpenTab>
}

/** Hidden window and contents for one open tab. */
interface OpenTab {
  readonly window: ElectronBrowserWindow
  readonly stopCrashWatch: () => void
}

/** Observed Chromium page facts. */
interface ObservedPage {
  readonly url: string
  readonly title: string
  readonly text: string
}

/** Reject an invalid deployment-varying duration before creating windows. */
function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`browser-runtime-electron: ${name} must be a positive safe integer no greater than ${String(MAX_TIMER_DELAY_MS)}`)
  }
}

/** Reject an invalid viewport dimension. */
function assertViewport(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`browser-runtime-electron: ${name} must be a positive safe integer`)
  }
}

/** Reject empty strings that Schemastery's required marker still admits. */
function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`browser-runtime-electron: ${name} must be non-empty`)
}

/** Fail composition unless this process is Electron or a test installed a host. */
function assertElectronAvailable(): void {
  if (electronTestHost() !== undefined) return
  if (!isElectronProcess()) {
    throw new Error('browser-runtime-electron: process.versions.electron must be set; this Provider loads only inside Electron')
  }
}

/** Read a string from untrusted Chromium script output. */
function textValue(value: unknown, subject: string): string {
  if (typeof value !== 'string') {
    throw new BrowserRuntimeError(`Electron ${subject} must be a string`, 'BROWSER_PROTOCOL')
  }
  return value
}

/** In-process Electron Browser Runtime for temporary and named persistent Profiles. */
export class ElectronBrowserRuntime extends BrowserRuntime {
  static Config = Config

  /** Package-private identity for this concrete Provider generation. */
  readonly [ELECTRON_RUNTIME_STATE_OWNER]: ElectronRuntimeStateOwner = Object.freeze({})

  private readonly config: ResolvedConfig
  private readonly states = new Map<string, BrowserRuntimeState>()
  private readonly profiles = new Map<string, OpenProfile>()
  private host: ElectronHost | undefined
  private temporarySeq = 0
  private readonly recovering = new Set<string>()
  private presented: {
    readonly key: string
    readonly tab: OpenTab
    readonly bounds: ElectronWindowBounds
  } | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    assertNonEmpty('idPrefix', resolved.idPrefix)
    assertViewport('viewportWidth', resolved.viewportWidth)
    assertViewport('viewportHeight', resolved.viewportHeight)
    assertDuration('requestTimeoutMs', resolved.requestTimeoutMs)
    assertElectronAvailable()
    this.config = resolved
    this.host = electronTestHost()
    ctx.effect(
      () => registerElectronRuntimeStateReader(this[ELECTRON_RUNTIME_STATE_OWNER], () => this.states),
      'Electron Browser Runtime state reader',
    )
    ctx.effect(() => () => this.teardown(), 'Electron Browser Runtime teardown')
  }

  /* jscpd:ignore-start */
  /** Emit one committed state while containing broken ordinary observers. */
  private notifyState(state: BrowserRuntimeState): void {
    emitBrowserRuntimeState(this.ctx, state, (error) => {
      this.ctx.logger.warn('browser-runtime-electron: a browser/runtime-state observer failed')
      this.ctx.logger.warn(error)
    })
  }

  /** Commit and publish one immutable Provider state. */
  private commit<T extends BrowserRuntimeState>(state: T): T {
    return commitBrowserRuntimeState(
      this.states,
      electronRuntimeStateValidator(this[ELECTRON_RUNTIME_STATE_OWNER]),
      (committed) => { this.notifyState(committed) },
      state,
    )
  }

  /** Resolve the addressed Provider state. */
  private addressed(target: BrowserTarget): BrowserRuntimeState {
    return addressedBrowserRuntimeStateFrom(this.states, target)
  }

  /** Resolve an open page or reject its terminal close receipt. */
  protected override openPage(target: BrowserTarget): BrowserPageState {
    const state = this.addressed(target)
    if (state.status !== 'open') {
      throw new BrowserRuntimeError(
        state.status === 'unavailable' ? 'Electron browser runtime is unavailable' : 'browser target is closed',
        state.status === 'unavailable' ? 'BROWSER_RUNTIME_UNAVAILABLE' : 'BROWSER_NOT_OPEN',
      )
    }
    return state
  }

  /** Enforce optimistic mutation ordering. */
  protected override expectRevision(state: BrowserRuntimeState, revision: number): void {
    requireExpectedBrowserRevision(state, revision)
  }

  /* jscpd:ignore-end */

  /** Resolve the open Electron Profile for one addressed target. */
  private openProfile(target: BrowserTarget): OpenProfile {
    const profile = this.profiles.get(target.profileId)
    if (profile === undefined) {
      throw new BrowserRuntimeError('Electron no longer reports the addressed tab', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    return profile
  }

  /** Resolve the hidden window for one addressed target. */
  private openTab(target: BrowserTarget): OpenTab {
    const tab = this.openProfile(target).tabs.get(target.tabId)
    if (tab === undefined || tab.window.isDestroyed() || tab.window.webContents.isDestroyed()) {
      throw new BrowserRuntimeError('Electron no longer reports the addressed tab', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    return tab
  }

  /** First open page, used when a renderer crash has to recover one visible tab. */
  private firstOpen(): BrowserPageState | undefined {
    return [...this.states.values()].find((state): state is BrowserPageState => state.status === 'open')
  }

  /** Load Electron APIs once after plugin construction. */
  private async hostApis(): Promise<ElectronHost> {
    if (this.host !== undefined) return this.host
    this.host = await loadElectronHost()
    return this.host
  }

  /** Bound one Chromium operation by requestTimeoutMs and the caller signal. */
  private async withTimeout<T>(
    signal: AbortSignal | undefined,
    window: ElectronBrowserWindow | undefined,
    operation: (combined: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assertBrowserNotAborted(signal)
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    try {
      return await operation(combined)
    } catch (error) {
      const callerAborted = signal?.aborted === true
      const timedOut = deadline.aborted && !callerAborted
      if (
        (callerAborted || timedOut)
        && window !== undefined
        && !window.isDestroyed()
        && !window.webContents.isDestroyed()
      ) {
        window.webContents.stop()
      }
      if (signal?.aborted) assertBrowserNotAborted(signal)
      if (error instanceof BrowserRuntimeError) {
        if (error.code === 'BROWSER_ABORTED' && signal?.aborted !== true) {
          throw new BrowserRuntimeError(`Electron operation failed: ${error.message}`, 'BROWSER_RUNTIME_UNAVAILABLE')
        }
        throw error
      }
      throw new BrowserRuntimeError(`Electron operation failed: ${String(error)}`, 'BROWSER_RUNTIME_UNAVAILABLE')
    }
  }

  /**
   * Race one webContents operation against abort, then stop Chromium and join
   * the raced promise before the exclusive queue advances.
   */
  private async raceContents<T>(
    window: ElectronBrowserWindow,
    operation: Promise<T>,
    combined: AbortSignal,
  ): Promise<T> {
    const aborted = new Promise<never>((_, reject) => {
      combined.addEventListener('abort', () => {
        reject(new BrowserRuntimeError(`browser operation aborted: ${String(combined.reason)}`, 'BROWSER_ABORTED'))
      }, { once: true })
    })
    try {
      return await Promise.race([operation, aborted])
    } catch (error) {
      if (
        error instanceof BrowserRuntimeError
        && error.code === 'BROWSER_ABORTED'
        && !window.isDestroyed()
        && !window.webContents.isDestroyed()
      ) {
        window.webContents.stop()
      }
      await operation.then(() => undefined, () => undefined)
      throw error
    }
  }

  /** Create or reuse the Chromium session for one persist or ephemeral partition. */
  private sessionFor(chrome: BrowserProfileChrome, host: ElectronHost): ElectronSession {
    return host.session.fromPartition(chrome.partition)
  }

  /**
   * Place one open page over the Desktop sidebar viewport.
   * A missing tab is a no-op so a stale renderer attach cannot throw.
   * Repeating the same target and bounds does not show, focus, or activate.
   * @param target - Session-owned tab identity.
   * @param bounds - Content-relative DIP rectangle of the chrome viewport.
   * @param parent - Desktop Host `BrowserWindow`.
   */
  present(target: BrowserTarget, bounds: ElectronWindowBounds, parent: unknown): void {
    const tab = this.profiles.get(target.profileId)?.tabs.get(target.tabId)
    if (tab === undefined || tab.window.isDestroyed()) return
    const key = browserTargetKey(target)
    if (
      this.presented?.key === key
      && sameWindowBounds(this.presented.bounds, bounds)
    ) return
    if (this.presented !== undefined && this.presented.key !== key) {
      this.concealWindow(this.presented.tab.window)
    }
    tab.window.setBounds(bounds)
    tab.window.setParentWindow(parent)
    tab.window.setBounds(bounds)
    if (this.presented?.key !== key) tab.window.showInactive()
    this.presented = { key, tab, bounds }
  }

  /**
   * Hide the presented page when it matches `target`.
   * @param target - Tab that is leaving the visible viewport.
   */
  conceal(target: BrowserTarget): void {
    if (this.presented?.key !== browserTargetKey(target)) return
    this.concealWindow(this.presented.tab.window)
    this.presented = undefined
  }

  /**
   * Put the presented page above Host chrome after a menu or dialog closes.
   * A missing presentation is a no-op.
   */
  raisePresented(): void {
    this.presented?.tab.window.raise()
  }

  /** Open one page window in the Profile partition. */
  private createWindow(profile: OpenProfile, host: ElectronHost): ElectronBrowserWindow {
    const window = new host.BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      width: this.config.viewportWidth,
      height: this.config.viewportHeight,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: profile.chrome.partition,
        offscreen: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    window.webContents.setWindowOpenHandler?.((details) => {
      if (
        details.url.length > 0
        && !window.isDestroyed()
        && !window.webContents.isDestroyed()
      ) {
        void window.webContents.loadURL(details.url).then(() => undefined, () => undefined)
      }
      return { action: 'deny' }
    })
    return window
  }

  /** Hide one page window without destroying its contents. */
  private concealWindow(window: ElectronBrowserWindow): void {
    if (window.isDestroyed()) return
    window.hide()
  }

  /** Watch renderer-process loss and project an unavailable state. */
  private watchCrash(target: BrowserTarget, window: ElectronBrowserWindow): () => void {
    const onGone = (): void => {
      this.scheduleRecovery(target, 'crashed', true)
    }
    window.webContents.on('render-process-gone', onGone)
    return () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.off('render-process-gone', onGone)
      }
    }
  }

  /** Destroy one hidden window if this Profile still records it. */
  private destroyExistingTab(profile: OpenProfile, tabId: string): void {
    const tab = profile.tabs.get(tabId)
    if (tab === undefined) return
    this.destroyTab(tab)
  }

  /** Destroy one hidden window without throwing after Chromium already closed it. */
  private destroyTab(tab: OpenTab): void {
    if (this.presented?.tab === tab) this.presented = undefined
    tab.stopCrashWatch()
    if (tab.window.isDestroyed()) return
    tab.window.destroy()
  }

  /** Read URL, title, and visible text from one hidden contents. */
  private async observeContents(window: ElectronBrowserWindow, signal: AbortSignal | undefined): Promise<ObservedPage> {
    return this.withTimeout(signal, window, async (combined) => {
      const url = window.webContents.getURL()
      const title = window.webContents.getTitle()
      if (isChromeErrorUrl(url)) {
        return Object.freeze({ url, title, text: '' })
      }
      const text = await this.raceContents(window, window.webContents.executeJavaScript(PAGE_TEXT_SCRIPT), combined)
      return Object.freeze({
        url,
        title,
        text: textValue(text, 'page text'),
      })
    })
  }

  /** Re-read one open page without advancing its DSH revision. */
  private async page(
    state: BrowserPageState,
    signal: AbortSignal | undefined,
    fallbackUrl = state.url,
  ): Promise<BrowserPageState> {
    const observed = await this.observeContents(this.openTab(state.target).window, signal)
    return Object.freeze({
      ...state,
      url: pageDisplayUrl(observed.url, fallbackUrl),
      title: observed.title,
      text: observed.text,
      storage: EMPTY_BROWSER_PROFILE_STORAGE,
    })
  }

  /** Navigate one hidden contents and wait for the first successful load. */
  private async load(window: ElectronBrowserWindow, url: string, signal: AbortSignal | undefined): Promise<void> {
    await this.withTimeout(signal, window, async (combined) => {
      try {
        await this.raceContents(window, window.webContents.loadURL(url), combined)
      } catch (error) {
        if (combined.aborted) throw error
        if (!isCommittedLoadError(error)) throw error
      }
    })
  }

  /** Capture one PNG screenshot, retrying one pre-first-frame compositor miss. */
  private async capture(window: ElectronBrowserWindow, signal: AbortSignal | undefined): Promise<string> {
    return this.withTimeout(signal, window, async (combined) => {
      const capturePage = async () => (
        await this.raceContents(window, window.webContents.capturePage(), combined)
      )
      let image: Awaited<ReturnType<typeof capturePage>>
      try {
        image = await capturePage()
      } catch (error) {
        if (!isTransientCaptureError(error)) throw error
        await this.raceContents(
          window,
          window.webContents.executeJavaScript(NEXT_ANIMATION_FRAME_SCRIPT),
          combined,
        )
        image = await capturePage()
      }
      const bytes = image.toPNG()
      if (bytes.byteLength === 0) {
        throw new BrowserRuntimeError('Electron screenshot response must be image/png', 'BROWSER_PROTOCOL')
      }
      return Buffer.from(bytes).toString('base64')
    })
  }

  /** Persist identity-retaining Profile storage; temporary partitions stay in memory. */
  private async flush(profile: OpenProfile): Promise<void> {
    if (!browserProfileRetainsIdentity(profile.chrome.kind)) return
    await profile.session.flushStorageData()
  }

  /** Drop temporary partition storage after its last tab closes. */
  private async forgetTemporary(profile: OpenProfile): Promise<void> {
    if (profile.chrome.kind !== 'temporary') return
    await profile.session.clearStorageData()
  }

  /* jscpd:ignore-start */
  /** Project availability loss and append one recovery transaction behind admitted work. */
  private scheduleRecovery(
    target: BrowserTarget,
    reason: 'crashed' | 'unhealthy',
    projectNow: boolean,
  ): BrowserRuntimeState | undefined {
    const key = browserTargetKey(target)
    if (this.recovering.has(key) || [...this.states.values()].every(state => state.status === 'closed')) {
      return this.states.get(key) ?? this.firstOpen() ?? [...this.states.values()].at(-1)
    }
    const lastOpen = this.states.get(key)
    const open = lastOpen !== undefined && lastOpen.status === 'open' ? lastOpen : undefined
    if (open === undefined) return lastOpen ?? [...this.states.values()].at(-1)
    this.recovering.add(key)
    const projected = projectNow
      ? this.commit({
        status: 'unavailable' as const,
        target: open.target,
        revision: open.revision + 1,
        reason,
        reconnecting: true,
      })
      : undefined
    const recovery = this.queue.then(async () => {
      if (this.closing || this.disposed) return
      const current = this.addressed(open.target)
      const unavailable = projected ?? this.commit({
        status: 'unavailable' as const,
        target: open.target,
        revision: current.revision + 1,
        reason,
        reconnecting: true,
      })
      await this.reconnect(open, unavailable)
    })
    this.queue = recovery.then(() => undefined, (error: unknown) => {
      this.ctx.logger.warn('browser-runtime-electron: reconnect transaction failed')
      this.ctx.logger.warn(error)
    })
    void recovery.then(() => undefined, () => undefined).finally(() => { this.recovering.delete(key) })
    return projected
  }

  /** Recreate the hidden window for one crashed tab and restore its last URL. */
  private async reconnect(
    lastOpen: BrowserPageState,
    unavailable: Extract<BrowserRuntimeState, { status: 'unavailable' }>,
  ): Promise<void> {
    if (this.closing || this.disposed) return
    try {
      const host = await this.hostApis()
      const profile = this.openProfile(lastOpen.target)
      this.destroyExistingTab(profile, lastOpen.target.tabId)
      const window = this.createWindow(profile, host)
      const tab: OpenTab = { window, stopCrashWatch: this.watchCrash(lastOpen.target, window) }
      profile.tabs.set(lastOpen.target.tabId, tab)
      await this.load(window, lastOpen.url, undefined)
      const restored = await this.page(lastOpen, undefined)
      this.commit({ ...restored, revision: unavailable.revision + 1, focused: false })
    } catch (error) {
      this.ctx.logger.warn('browser-runtime-electron: reconnect attempts exhausted')
      this.ctx.logger.warn(error)
      const profile = this.profiles.get(lastOpen.target.profileId)
      if (profile !== undefined) {
        this.destroyExistingTab(profile, lastOpen.target.tabId)
        profile.tabs.delete(lastOpen.target.tabId)
        if (profile.tabs.size === 0) this.profiles.delete(lastOpen.target.profileId)
      }
      this.commitReconnectFailed(unavailable.target)
    }
  }
  /* jscpd:ignore-end */

  /** Commit reconnect-failed when the target is still unavailable. */
  private commitReconnectFailed(target: BrowserTarget): void {
    const current = this.states.get(browserTargetKey(target))
    if (current?.status !== 'unavailable') return
    this.commit({
      ...current,
      revision: current.revision + 1,
      reason: 'reconnect-failed',
      reconnecting: false,
    })
  }

  /* jscpd:ignore-start */
  async create(request: BrowserCreateRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const attached = resolveBrowserCreateAttach(this.states.values(), request.attach)
      if (request.profile === 'temporary' && attached === undefined) this.temporarySeq += 1
      const created = attached === undefined
        ? resolveBrowserProfileCreate(this.config.idPrefix, request, this.temporarySeq)
        : {
          profileId: attached.target.profileId,
          sessionName: this.openProfile(attached.target).sessionName,
          chrome: attached.chrome,
        }
      assertUnattachedPersistentWriterAvailable(this.states.values(), request, created.chrome.partition)
      assertBrowserCreateAttach(this.states.values(), created.profileId, request.attach)
      const host = await this.hostApis()
      const existing = this.profiles.get(created.profileId)
      const profile = existing ?? {
        sessionName: created.sessionName,
        chrome: created.chrome,
        session: this.sessionFor(created.chrome, host),
        tabs: new Map<string, OpenTab>(),
      }
      const historical = [...this.states.values()].filter(state => state.target.profileId === created.profileId)
      const tabSeq = historical.length + 1
      const workspaceSeq = request.profile === 'shared'
        ? browserSharedWorkspaceSeq(this.states.values(), created.profileId, request.attach)
        : undefined
      const target = browserTargetFor(
        created.profileId, created.sessionName, tabSeq, request.attach, workspaceSeq,
      )
      const window = this.createWindow(profile, host)
      const tab: OpenTab = { window, stopCrashWatch: this.watchCrash(target, window) }
      profile.tabs.set(target.tabId, tab)
      this.profiles.set(created.profileId, profile)
      try {
        await this.load(window, 'about:blank', request.signal)
        const observed = await this.observeContents(window, request.signal)
        return this.commit({
          status: 'open',
          target,
          revision: 0,
          url: observed.url,
          title: observed.title,
          text: observed.text,
          focused: false,
          chrome: created.chrome,
          storage: EMPTY_BROWSER_PROFILE_STORAGE,
        })
      } catch (error) {
        this.destroyTab(tab)
        profile.tabs.delete(target.tabId)
        if (this.profiles.get(created.profileId) === profile && profile.tabs.size === 0) {
          this.profiles.delete(created.profileId)
        }
        throw error
      }
    })
  }

  async navigate(request: BrowserNavigateRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      await this.load(this.openTab(request.target).window, request.url, request.signal)
      const page = await this.page(state, request.signal, request.url)
      return this.commit({
        ...page,
        revision: state.revision + 1,
      })
    })
  }

  async observe(request: BrowserObserveRequest): Promise<BrowserRuntimeState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.addressed(request.target)
      if (state.status !== 'open') return state
      try {
        return await this.page(state, request.signal)
      } catch (error) {
        if (error instanceof BrowserRuntimeError && error.code === 'BROWSER_RUNTIME_UNAVAILABLE') {
          return this.scheduleRecovery(request.target, 'unhealthy', true)
            ?? this.states.get(browserTargetKey(request.target))
            ?? state
        }
        throw error
      }
    })
  }

  async screenshot(request: BrowserObserveRequest): Promise<BrowserScreenshot> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      const page = await this.page(state, request.signal)
      const data = await this.capture(this.openTab(request.target).window, request.signal)
      return Object.freeze({
        target: state.target,
        revision: state.revision,
        url: page.url,
        title: page.title,
        mediaType: 'image/png' as const,
        data,
      })
    })
  }

  async focus(request: BrowserMutationRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      this.openTab(request.target).window.webContents.focus()
      return this.commit({ ...state, revision: state.revision + 1, focused: true })
    })
  }

  async input(request: BrowserInputRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      const window = this.openTab(request.target).window
      if (request.url !== undefined) await this.load(window, request.url, request.signal)
      window.webContents.focus()
      if (request.text !== undefined) await this.typeIntoPage(window, request.text, request.signal)
      const page = await this.page(
        state,
        request.signal,
        request.url !== undefined ? request.url : state.url,
      )
      return this.commit({
        ...page,
        revision: state.revision + 1,
      })
    })
  }

  /**
   * Deliver synthetic Agent text through one path: an insert script when an input,
   * textarea, or contentEditable is focused; otherwise `char` input events.
   * A newline is U+000A in a focused editable control. A focused single-line
   * input receives that character only when the control accepts it. With no
   * focused editable control, each newline is a `char` event whose keyCode is
   * `\\n`.
   */
  private async typeIntoPage(window: ElectronBrowserWindow, text: string, signal: AbortSignal | undefined): Promise<void> {
    const focused = await this.withTimeout(signal, window, async combined => (
      await this.raceContents(window, window.webContents.executeJavaScript(FOCUSED_EDITABLE_SCRIPT), combined)
    ))
    if (focused === true) {
      await this.withTimeout(signal, window, async (combined) => {
        await this.raceContents(
          window,
          window.webContents.executeJavaScript(`(${INSERT_TEXT_SCRIPT})(${JSON.stringify(text)})`),
          combined,
        )
      })
      return
    }
    for (const keyCode of text) {
      assertBrowserNotAborted(signal)
      window.webContents.sendInputEvent({ type: 'char', keyCode })
    }
  }

  async close(request: BrowserMutationRequest): Promise<BrowserClosedState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.addressed(request.target)
      this.expectRevision(state, request.expectedRevision)
      if (state.status === 'closed') throw new BrowserRuntimeError('browser target is closed', 'BROWSER_NOT_OPEN')
      const profile = this.openProfile(request.target)
      const tab = profile.tabs.get(state.target.tabId)
      if (tab !== undefined) this.destroyTab(tab)
      profile.tabs.delete(state.target.tabId)
      const lastTab = profile.tabs.size === 0
      if (lastTab) {
        await this.flush(profile)
        await this.forgetTemporary(profile)
        this.profiles.delete(state.target.profileId)
      }
      return this.commit({ status: 'closed' as const, target: state.target, revision: state.revision + 1 })
    })
  }
  /* jscpd:ignore-end */

  /** Drain admitted work and destroy remaining hidden windows. */
  private async teardown(): Promise<void> {
    this.closing = true
    await this.queue
    for (const profile of this.profiles.values()) {
      for (const tab of profile.tabs.values()) this.destroyTab(tab)
      profile.tabs.clear()
    }
    for (const state of [...this.states.values()]) {
      if (state.status !== 'open' && state.status !== 'unavailable') continue
      this.commit({ status: 'closed', target: state.target, revision: state.revision + 1 })
    }
    for (const profile of this.profiles.values()) {
      try {
        await this.flush(profile)
        await this.forgetTemporary(profile)
      } catch (error) {
        this.ctx.logger.warn('browser-runtime-electron: partition cleanup failed before teardown')
        this.ctx.logger.warn(error)
      }
    }
    this.profiles.clear()
    this.disposed = true
  }
}

export default ElectronBrowserRuntime
export { electronHostFromModule, isElectronProcess, loadElectronHost, requireElectronProcess } from './electron.ts'
export type {
  ElectronBrowserWindowConstructor,
  ElectronBrowserWindowOptions,
  ElectronHost,
  ElectronSessionModule,
  ElectronWindowBounds,
} from './electron.ts'
export { listenElectronBrowserHttp } from './http.ts'
export type { ElectronBrowserHttpServer } from './http.ts'
export { TANDEM_UPSTREAM_REVISION, TANDEM_UPSTREAM_VERSION } from './protocol.ts'
