/** Tandem-shaped HTTP Service Provider for the Browser Runtime capability. @module @deepseek-ai/dsh-browser-runtime-tandem */

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
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
  openBrowserPagesForProfile,
  requireExpectedBrowserRevision,
  resolveBrowserCreateAttach,
  resolveBrowserProfileCreate,
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
  BrowserProfileStorage,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
} from '@deepseek-ai/dsh-browser-runtime'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  registerTandemRuntimeStateReader,
  TANDEM_RUNTIME_STATE_OWNER,
  tandemRuntimeStateValidator,
  type TandemRuntimeStateOwner,
} from './runtime-state.ts'

/** Pinned Tandem Browser source revision whose HTTP protocol this Provider implements. */
export const TANDEM_UPSTREAM_REVISION = '3b613cfd4c299609ca7ca415d638c1b71c6ba5de'
/** Tandem Browser version reported by the pinned source revision. */
export const TANDEM_UPSTREAM_VERSION = '1.11.4'

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** HTTP and optional fixture-process configuration for one Tandem-shaped runtime. */
export interface Config {
  /** Optional fixture executable used only by HTTP protocol tests. Production Desktop omits this. */
  command?: string
  /** Arguments passed without shell interpretation when `command` is set. */
  args?: string[]
  /** Existing directory used as the optional fixture child working directory. */
  cwd?: string
  /** Explicit environment layered over the subprocess service's credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Loopback Tandem-shaped HTTP API origin, including its configured port. */
  baseUrl: string
  /** Local file where the HTTP server writes its generated API token. */
  tokenFile: string
  /** Prefix for DSH-owned opaque Profile, Workspace, and browser identities. */
  idPrefix?: string
  /** Bound on HTTP health verification. */
  startupTimeoutMs?: number
  /** Bound on each Tandem-shaped HTTP operation. */
  requestTimeoutMs?: number
  /** Delay between startup health probes. */
  healthPollMs?: number
  /** Upper bound on upstream page-settle waiting for one content read. */
  pageSettleMs?: number
  /** Number of fixture-child restarts after an unexpected exit. Ignored without `command`. */
  reconnectAttempts?: number
  /** Delay before each reconnect attempt. */
  reconnectDelayMs?: number
  /** Subprocess tree SIGTERM-to-SIGKILL grace used for fixture teardown. */
  processGraceMs?: number
  /** Maximum bytes accepted from one Tandem-shaped HTTP response. */
  maxResponseBytes?: number
  /**
   * When `false`, this client never spawns a fixture child and rejects
   * `command`/`cwd` at plugin load. Production Desktop sets `false`.
   */
  sidecar?: boolean
}

/** Runtime configuration schema for the Tandem-shaped HTTP Browser Provider. */
export const Config: z<Config> = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  baseUrl: z.string().required(),
  tokenFile: z.string().required(),
  idPrefix: z.string().default('tandem'),
  startupTimeoutMs: z.number().default(60_000),
  requestTimeoutMs: z.number().default(30_000),
  healthPollMs: z.number().default(250),
  pageSettleMs: z.number().default(250),
  reconnectAttempts: z.number().default(2),
  reconnectDelayMs: z.number().default(500),
  processGraceMs: z.number().default(5_000),
  maxResponseBytes: z.number().default(10_000_000),
  sidecar: z.boolean().default(true),
})

type ResolvedConfig = Config & Required<Omit<Config, 'command' | 'cwd'>>

/** Fields the pinned Tandem tab inventory always carries; `title` and `url` may be empty while a page settles. */
interface TandemTab {
  readonly id: string
  readonly url: string
  readonly title: string
}

interface TandemPageContent {
  readonly title: string
  readonly url: string
  readonly text: string
  readonly storage: BrowserProfileStorage
  readonly revision?: number
}

/** Reject an invalid deployment-varying duration before spawning a child. */
function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`browser-runtime-tandem: ${name} must be a positive safe integer no greater than ${String(MAX_TIMER_DELAY_MS)}`)
  }
}

/** Reject a value outside the non-negative integer retry vocabulary. */
function assertRetries(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('browser-runtime-tandem: reconnectAttempts must be a non-negative safe integer')
  }
}

/** Reject an invalid response-size bound before spawning a child. */
function assertByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('browser-runtime-tandem: maxResponseBytes must be a positive safe integer')
  }
}

/** Parse and constrain the bearer-token API origin to the local machine. */
function resolveBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('browser-runtime-tandem: baseUrl must be an absolute loopback HTTP origin')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('browser-runtime-tandem: baseUrl must be an absolute loopback HTTP origin')
  }
  return url.origin
}

/** Reject empty strings that Schemastery's required marker still admits. */
function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`browser-runtime-tandem: ${name} must be non-empty`)
}

/** One open Tandem Profile lifecycle owned by this Provider. */
interface OpenProfile {
  readonly sessionName: string
  readonly chrome: BrowserProfileChrome
  readonly tabs: Map<string, string>
}

/** Narrow one untrusted JSON value to an object record. */
function objectValue(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserRuntimeError(`Tandem ${subject} response must be an object`, 'BROWSER_PROTOCOL')
  }
  return value as Record<string, unknown>
}

/** Read one required string field from an untrusted Tandem response. */
function stringField(value: Record<string, unknown>, key: string, subject: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new BrowserRuntimeError(`Tandem ${subject} response field ${key} must be a non-empty string`, 'BROWSER_PROTOCOL')
  }
  return field
}

/** Read one required string field that the pinned protocol admits as empty. */
function textField(value: Record<string, unknown>, key: string, subject: string): string {
  const field = value[key]
  if (typeof field !== 'string') {
    throw new BrowserRuntimeError(`Tandem ${subject} response field ${key} must be a string`, 'BROWSER_PROTOCOL')
  }
  return field
}

/** Read one required safe-integer field from an untrusted Tandem response. */
function numberField(value: Record<string, unknown>, key: string, subject: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
    throw new BrowserRuntimeError(`Tandem ${subject} response field ${key} must be a safe integer`, 'BROWSER_PROTOCOL')
  }
  return field
}

/** Use observed page-content storage, or empty facts when the route omitted them. */
function resolveCreateStorage(content: TandemPageContent | undefined): BrowserProfileStorage {
  return content?.storage ?? EMPTY_BROWSER_PROFILE_STORAGE
}

/** Read optional partition-backed identity facts from a page-content response. */
function parseStorage(value: Record<string, unknown>): BrowserProfileStorage {
  const field = value.storage
  if (field === undefined) return EMPTY_BROWSER_PROFILE_STORAGE
  const storage = objectValue(field, 'page content storage')
  return Object.freeze({
    cookies: textField(storage, 'cookies', 'page content storage'),
    localStorage: textField(storage, 'localStorage', 'page content storage'),
    indexedDb: textField(storage, 'indexedDb', 'page content storage'),
    cache: textField(storage, 'cache', 'page content storage'),
    serviceWorker: textField(storage, 'serviceWorker', 'page content storage'),
  })
}

function tandemTab(value: unknown, subject: string): TandemTab {
  const tab = objectValue(value, subject)
  return Object.freeze({
    id: stringField(tab, 'id', subject),
    url: textField(tab, 'url', subject),
    title: textField(tab, 'title', subject),
  })
}

/** Managed Tandem Browser Runtime for temporary and named persistent Profiles. */
export class TandemBrowserRuntime extends BrowserRuntime {
  static Config = Config

  /** Package-private identity for this concrete Provider generation. */
  readonly [TANDEM_RUNTIME_STATE_OWNER]: TandemRuntimeStateOwner = Object.freeze({})

  private readonly config: ResolvedConfig
  private readonly baseUrl: string
  private readonly states = new Map<string, BrowserRuntimeState>()
  private readonly profiles = new Map<string, OpenProfile>()
  private process: SubprocessHandle | undefined
  private temporarySeq = 0
  private readonly intentionalStops = new WeakSet<SubprocessHandle>()
  private recoveryScheduled = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (resolved.command !== undefined) assertNonEmpty('command', resolved.command)
    if (resolved.cwd !== undefined) assertNonEmpty('cwd', resolved.cwd)
    if ((resolved.command === undefined) !== (resolved.cwd === undefined)) {
      throw new Error('browser-runtime-tandem: command and cwd must both be set for a fixture child, or both omitted')
    }
    if (!resolved.sidecar && (resolved.command !== undefined || resolved.cwd !== undefined)) {
      throw new Error('browser-runtime-tandem: command and cwd must be omitted when sidecar is disabled')
    }
    assertNonEmpty('tokenFile', resolved.tokenFile)
    assertNonEmpty('idPrefix', resolved.idPrefix)
    assertDuration('startupTimeoutMs', resolved.startupTimeoutMs)
    assertDuration('requestTimeoutMs', resolved.requestTimeoutMs)
    assertDuration('healthPollMs', resolved.healthPollMs)
    assertDuration('pageSettleMs', resolved.pageSettleMs)
    assertDuration('reconnectDelayMs', resolved.reconnectDelayMs)
    assertDuration('processGraceMs', resolved.processGraceMs)
    assertByteLimit(resolved.maxResponseBytes)
    assertRetries(resolved.reconnectAttempts)
    this.config = resolved
    this.baseUrl = resolveBaseUrl(resolved.baseUrl)
    ctx.effect(
      () => registerTandemRuntimeStateReader(this[TANDEM_RUNTIME_STATE_OWNER], () => this.states),
      'Tandem Browser Runtime state reader',
    )
    ctx.effect(() => () => this.teardown(), 'Tandem Browser Runtime teardown')
  }

  /** Emit one committed state while containing broken ordinary observers. */
  private notifyState(state: BrowserRuntimeState): void {
    emitBrowserRuntimeState(this.ctx, state, (error) => {
      this.ctx.logger.warn('browser-runtime-tandem: a browser/runtime-state observer failed')
      this.ctx.logger.warn(error)
    })
  }

  /** Commit and publish one immutable Provider state. */
  private commit<T extends BrowserRuntimeState>(state: T): T {
    return commitBrowserRuntimeState(
      this.states,
      tandemRuntimeStateValidator(this[TANDEM_RUNTIME_STATE_OWNER]),
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
    if (state.status === 'unavailable') {
      throw new BrowserRuntimeError('Tandem browser runtime is unavailable', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    if (state.status !== 'open') throw new BrowserRuntimeError('browser target is closed', 'BROWSER_NOT_OPEN')
    return state
  }

  /** Enforce optimistic mutation ordering. */
  protected override expectRevision(state: BrowserRuntimeState, revision: number): void {
    requireExpectedBrowserRevision(state, revision)
  }

  /** Resolve the open Tandem Profile for one addressed target. */
  private openProfile(target: BrowserTarget): OpenProfile {
    const profile = this.profiles.get(target.profileId)
    if (profile === undefined) {
      throw new BrowserRuntimeError('Tandem no longer reports the addressed tab', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    return profile
  }

  /** Resolve the current Tandem-owned tab identity for the stable DSH target. */
  private upstreamTabId(target: BrowserTarget): string {
    const tabId = this.openProfile(target).tabs.get(target.tabId)
    if (tabId === undefined) {
      throw new BrowserRuntimeError('Tandem no longer reports the addressed tab', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    return tabId
  }

  /** Resolve the Tandem session name for one addressed target. */
  private sessionNameFor(target: BrowserTarget): string {
    return this.openProfile(target).sessionName
  }

  /** First open page, used when a child crash has to recover one visible tab. */
  private firstOpen(): BrowserPageState | undefined {
    return [...this.states.values()].find((state): state is BrowserPageState => state.status === 'open')
  }



  /** Read the current Tandem bearer token after startup generated it. */
  private async token(): Promise<string> {
    let token: string
    try {
      token = (await readFile(this.config.tokenFile, 'utf8')).trim()
    } catch (error) {
      throw new BrowserRuntimeError(`Tandem API token is unavailable: ${String(error)}`, 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    if (token.length < 32) {
      throw new BrowserRuntimeError('Tandem API token must contain at least 32 characters', 'BROWSER_PROTOCOL')
    }
    return token
  }

  /** Read a bounded response body before decoding protocol data. */
  private async responseBytes(response: Response): Promise<Uint8Array> {
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > this.config.maxResponseBytes) {
      throw new BrowserRuntimeError('Tandem HTTP response exceeds maxResponseBytes', 'BROWSER_PROTOCOL')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > this.config.maxResponseBytes) {
      throw new BrowserRuntimeError('Tandem HTTP response exceeds maxResponseBytes', 'BROWSER_PROTOCOL')
    }
    return bytes
  }

  /** Execute one bounded Tandem HTTP request and retain its status-independent bytes. */
  private async request(
    path: string,
    init: Omit<RequestInit, 'signal'>,
    signal: AbortSignal | undefined,
    authenticated = true,
  ): Promise<{ response: Response; bytes: Uint8Array }> {
    assertBrowserNotAborted(signal)
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const headers = new Headers(init.headers)
    if (authenticated) headers.set('authorization', `Bearer ${await this.token()}`)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: combined })
    } catch (error) {
      if (signal?.aborted) assertBrowserNotAborted(signal)
      throw new BrowserRuntimeError(`Tandem HTTP request failed: ${String(error)}`, 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    const bytes = await this.responseBytes(response)
    if (!response.ok) {
      const detail = Buffer.from(bytes).toString('utf8').slice(0, 1_000)
      try {
        const parsed: unknown = JSON.parse(detail)
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && (parsed as { code?: unknown }).code === 'BROWSER_REVISION_CONFLICT'
        ) {
          const message = (parsed as { error?: unknown }).error
          throw new BrowserRuntimeError(
            typeof message === 'string' ? message : detail,
            'BROWSER_REVISION_CONFLICT',
          )
        }
      } catch (error) {
        if (error instanceof BrowserRuntimeError) throw error
      }
      throw new BrowserRuntimeError(`Tandem HTTP ${String(response.status)} for ${path}: ${detail}`, 'BROWSER_PROTOCOL')
    }
    return { response, bytes }
  }

  /** Decode one JSON response from the pinned Tandem protocol. */
  private async json(
    path: string,
    init: Omit<RequestInit, 'signal'>,
    signal: AbortSignal | undefined,
    authenticated = true,
  ): Promise<unknown> {
    const { bytes } = await this.request(path, init, signal, authenticated)
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
    } catch {
      throw new BrowserRuntimeError(`Tandem ${path} response must be valid JSON`, 'BROWSER_PROTOCOL')
    }
  }

  /** Wait for the child API and verify the pinned Tandem product and version. */
  private async waitForHealth(signal: AbortSignal | undefined): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      assertBrowserNotAborted(signal)
      if (this.process === undefined && this.config.command !== undefined) {
        throw new BrowserRuntimeError('Tandem child exited before startup health completed', 'BROWSER_RUNTIME_UNAVAILABLE')
      }
      try {
        const remaining = Math.max(1, deadline - Date.now())
        const startupSignal = AbortSignal.timeout(remaining)
        const probeSignal = signal === undefined ? startupSignal : AbortSignal.any([signal, startupSignal])
        const version = objectValue(await this.json('/agent/version', { method: 'GET' }, probeSignal, false), 'version')
        if (stringField(version, 'name', 'version') !== 'tandem-browser'
          || stringField(version, 'version', 'version') !== TANDEM_UPSTREAM_VERSION) {
          throw new BrowserRuntimeError(
            `Tandem runtime must report tandem-browser ${TANDEM_UPSTREAM_VERSION}`,
            'BROWSER_PROTOCOL',
          )
        }
        const status = objectValue(await this.json('/status', { method: 'GET' }, probeSignal, false), 'status')
        if (typeof status.ready !== 'boolean') {
          throw new BrowserRuntimeError('Tandem status response field ready must be boolean', 'BROWSER_PROTOCOL')
        }
        if (status.ready) return
      } catch (error) {
        // A caller abort propagates; an expired probe deadline is one more
        // failed sample that the startup bound below reports truthfully.
        if (signal?.aborted) assertBrowserNotAborted(signal)
        if (error instanceof BrowserRuntimeError && error.code === 'BROWSER_PROTOCOL') throw error
        lastError = error
      }
      await this.delay(this.config.healthPollMs, signal)
    }
    throw new BrowserRuntimeError(`Tandem startup health timed out: ${String(lastError)}`, 'BROWSER_RUNTIME_UNAVAILABLE')
  }

  /** Spawn one optional fixture child and wait for the pinned Tandem-shaped API. */
  private async startProcess(signal: AbortSignal | undefined): Promise<void> {
    if (this.config.command === undefined || this.config.cwd === undefined) {
      await this.waitForHealth(signal)
      return
    }
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new BrowserRuntimeError(
        'Tandem fixture command requires ctx.subprocess',
        'BROWSER_RUNTIME_UNAVAILABLE',
      )
    }
    const executable = await subprocess.resolveExecutable(this.config.command, this.config.env, signal)
    assertBrowserNotAborted(signal)
    const handle = subprocess.spawn({
      argv: [executable, ...this.config.args],
      cwd: this.config.cwd,
      env: this.config.env,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64_000 },
        stderr: { maxBytes: 64_000 },
      },
      graceMs: this.config.processGraceMs,
    })
    this.process = handle
    void handle.done.then(
      (outcome) => { this.processExited(handle, `exit ${String(outcome.exitCode)} signal ${String(outcome.signal)}`) },
      (error: unknown) => { this.processExited(handle, `spawn failure ${String(error)}`) },
    )
    try {
      await this.waitForHealth(signal)
    } catch (error) {
      await this.stopProcess(handle)
      throw error
    }
  }

  /** Terminate and join one exact Tandem child process tree. */
  private async stopProcess(handle = this.process): Promise<void> {
    if (handle === undefined) return
    this.intentionalStops.add(handle)
    if (this.process === handle) this.process = undefined
    handle.terminate()
    // A spawn-level failure rejects `done`; that failure is already reported
    // through processExited, so the join only awaits quiescence here.
    await handle.done.then(() => undefined, () => undefined)
  }

  /** Resolve after a configured delay or reject promptly when the caller cancels. */
  private delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
    assertBrowserNotAborted(signal)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, milliseconds)
      const onAbort = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new BrowserRuntimeError(`browser operation aborted: ${String(signal?.reason)}`, 'BROWSER_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Schedule one serialized reconnect after an unexpected child exit. */
  private processExited(handle: SubprocessHandle, detail: string): void {
    if (this.intentionalStops.has(handle) || this.process !== handle) return
    this.process = undefined
    if (this.closing || this.disposed || this.firstOpen() === undefined) return
    this.ctx.logger.warn(`browser-runtime-tandem: managed child exited unexpectedly (${detail})`)
    this.scheduleRecovery('crashed', false)
  }

  /** Project availability loss and append one recovery transaction behind admitted work. */
  private scheduleRecovery(
    reason: 'crashed' | 'unhealthy',
    projectNow: boolean,
  ): BrowserRuntimeState | undefined {
    if (this.recoveryScheduled || [...this.states.values()].every(state => state.status === 'closed')) {
      return this.firstOpen() ?? [...this.states.values()].at(-1)
    }
    const lastOpen = this.firstOpen()
    if (lastOpen === undefined) return [...this.states.values()].at(-1)
    this.recoveryScheduled = true
    const projected = projectNow
      ? this.commit({
        status: 'unavailable' as const,
        target: lastOpen.target,
        revision: lastOpen.revision + 1,
        reason,
        reconnecting: this.config.reconnectAttempts > 0,
      })
      : undefined
    const recovery = this.queue.then(async () => {
      if (this.closing || this.disposed) return
      const current = this.addressed(lastOpen.target)
      const unavailable = projected ?? this.commit({
        status: 'unavailable' as const,
        target: lastOpen.target,
        revision: current.revision + 1,
        reason,
        reconnecting: this.config.reconnectAttempts > 0,
      })
      await this.reconnect(lastOpen, unavailable)
    })
    this.queue = recovery.then(() => undefined, () => undefined)
    void recovery.finally(() => { this.recoveryScheduled = false }).catch((error: unknown) => {
      this.ctx.logger.warn('browser-runtime-tandem: reconnect transaction failed')
      this.ctx.logger.warn(error)
    })
    return projected
  }

  /** Restart Tandem a bounded number of times and restore the last real page. */
  private async reconnect(
    lastOpen: BrowserPageState,
    unavailable: Extract<BrowserRuntimeState, { status: 'unavailable' }>,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.config.reconnectAttempts; attempt += 1) {
      if (this.closing || this.disposed) return
      try {
        await this.stopProcess()
        await this.delay(this.config.reconnectDelayMs, undefined)
        await this.startProcess(undefined)
        const restoredProfile = this.openProfile(lastOpen.target)
        const tab = await this.createSession(restoredProfile.sessionName, undefined, lastOpen.url)
        restoredProfile.tabs.set(lastOpen.target.tabId, tab.id)
        const restored = await this.page(lastOpen, undefined)
        this.commit({ ...restored, revision: unavailable.revision + 1, focused: false })
        return
      } catch (error) {
        lastError = error
        await this.stopProcess()
      }
    }
    if (this.config.reconnectAttempts === 0) {
      // No restart will be attempted; an unavailable projection must never
      // leave a live browser child behind.
      await this.stopProcess()
    }
    const current = this.states.get(browserTargetKey(unavailable.target))
    if (this.config.reconnectAttempts > 0 && !this.closing && !this.disposed && current?.status === 'unavailable') {
      this.ctx.logger.warn('browser-runtime-tandem: reconnect attempts exhausted')
      this.ctx.logger.warn(lastError)
      this.commit({
        ...current,
        revision: current.revision + 1,
        reason: 'reconnect-failed',
        reconnecting: false,
      })
    }
  }

  /** Parse Tandem's session-create receipt and return its actual tab. */
  private async createSession(sessionName: string, signal: AbortSignal | undefined, url = 'about:blank'): Promise<TandemTab> {
    const response = objectValue(await this.json('/sessions/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: sessionName, url }),
    }, signal), 'session create')
    return tandemTab(response.tab, 'session create tab')
  }

  /** Return the addressed tab from Tandem's global tab inventory. */
  private async readTab(tabId: string, signal: AbortSignal | undefined): Promise<TandemTab> {
    const response = objectValue(await this.json('/tabs/list', { method: 'GET' }, signal), 'tabs list')
    if (!Array.isArray(response.tabs)) {
      throw new BrowserRuntimeError('Tandem tabs list response field tabs must be an array', 'BROWSER_PROTOCOL')
    }
    const tabs = response.tabs.map(value => tandemTab(value, 'tabs list tab'))
    const tab = tabs.find(value => value.id === tabId)
    if (tab === undefined) throw new BrowserRuntimeError('Tandem no longer reports the addressed tab', 'BROWSER_RUNTIME_UNAVAILABLE')
    return tab
  }

  /**
   * Read model-visible page content for one exact Tandem tab. The pinned
   * upstream route waits its internal 10s maxWait whenever a page offers
   * fewer than 1000 text characters, so the request carries provider-owned
   * settle bounds and a minimal length target instead of inheriting them.
   */
  private async readContent(tabId: string, signal: AbortSignal | undefined): Promise<TandemPageContent> {
    const query = `?settleMs=${String(this.config.pageSettleMs)}&timeout=${String(this.config.requestTimeoutMs)}&minLength=1`
    const content = objectValue(await this.json(`/page-content${query}`, {
      method: 'GET',
      headers: { 'x-tab-id': tabId },
    }, signal), 'page content')
    const revision = content.revision
    return Object.freeze({
      title: textField(content, 'title', 'page content'),
      url: stringField(content, 'url', 'page content'),
      text: textField(content, 'text', 'page content'),
      storage: parseStorage(content),
      ...(typeof revision === 'number' && Number.isSafeInteger(revision) ? { revision } : {}),
    })
  }

  /**
   * Re-read the page after a mutation response. A dead HTTP origin is not a
   * failed mutation: keep the engine-committed fallback and let observe
   * recover.
   * @param state - Open page used to address the tab.
   * @param signal - Caller abort signal forwarded to the content read.
   * @param fallback - Engine-committed page used when the follow-up read dies.
   * @returns the fresh page, or `fallback` when the HTTP origin is gone.
   */
  private async pageAfterMutation(
    state: BrowserPageState,
    signal: AbortSignal | undefined,
    fallback: BrowserPageState,
  ): Promise<BrowserPageState> {
    try {
      return await this.page(state, signal)
    } catch (error) {
      if (
        error instanceof BrowserRuntimeError
        && error.code === 'BROWSER_RUNTIME_UNAVAILABLE'
        && /HTTP request failed/.test(error.message)
      ) {
        return fallback
      }
      throw error
    }
  }

  /** Re-read one open page without advancing its DSH revision. */
  private async page(state: BrowserPageState, signal: AbortSignal | undefined): Promise<BrowserPageState> {
    const tab = await this.readTab(this.upstreamTabId(state.target), signal)
    const content = await this.readContent(tab.id, signal)
    return Object.freeze({
      ...state,
      revision: content.revision ?? state.revision,
      url: content.url,
      title: content.title,
      text: content.text,
      storage: content.storage,
    })
  }

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
      const existing = openBrowserPagesForProfile(this.states.values(), created.profileId)
      assertUnattachedPersistentWriterAvailable(this.states.values(), request, created.chrome.partition)
      assertBrowserCreateAttach(this.states.values(), created.profileId, request.attach)
      if (this.process === undefined) await this.startProcess(request.signal)
      try {
        const tab = await this.createSession(created.sessionName, request.signal)
        const profile = this.profiles.get(created.profileId) ?? {
          sessionName: created.sessionName,
          chrome: created.chrome,
          tabs: new Map<string, string>(),
        }
        const historical = [...this.states.values()].filter(state => state.target.profileId === created.profileId)
        const tabSeq = historical.length + 1
        const workspaceSeq = request.profile === 'shared'
          ? browserSharedWorkspaceSeq(this.states.values(), created.profileId, request.attach)
          : undefined
        const target = browserTargetFor(
          created.profileId, created.sessionName, tabSeq, request.attach, workspaceSeq,
        )
        profile.tabs.set(target.tabId, tab.id)
        this.profiles.set(created.profileId, profile)
        let content: TandemPageContent | undefined
        try {
          content = await this.readContent(tab.id, request.signal)
        } catch (error) {
          if (!(error instanceof BrowserRuntimeError && error.code === 'BROWSER_PROTOCOL')) throw error
        }
        const name = created.chrome.name
        return this.commit({
          status: 'open',
          target,
          revision: 0,
          url: content?.url || tab.url,
          title: content?.title || tab.title,
          text: content?.text || (name === undefined ? '' : `identity=${name}`),
          focused: false,
          chrome: created.chrome,
          storage: resolveCreateStorage(content),
        })
      } catch (error) {
        if (existing.length === 0) this.profiles.delete(created.profileId)
        if (this.profiles.size === 0) await this.stopProcess()
        throw error
      }
    })
  }

  /** Serialize one revision-checked mutation against an open page. */
  private mutateOpenPage<T>(
    request: BrowserMutationRequest,
    mutate: (state: BrowserPageState) => Promise<T>,
  ): Promise<T> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      return mutate(state)
    })
  }

  async navigate(request: BrowserNavigateRequest): Promise<BrowserPageState> {
    return this.mutateOpenPage(request, async (state) => {
      const response = objectValue(await this.json('/navigate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session': this.sessionNameFor(request.target) },
        body: JSON.stringify({
          url: request.url,
          tabId: this.upstreamTabId(request.target),
          expectedRevision: state.revision,
        }),
      }, request.signal), 'navigate')
      const revision = numberField(response, 'revision', 'navigate')
      const fallback = Object.freeze({
        ...state,
        revision,
        url: stringField(response, 'url', 'navigate'),
      })
      const page = await this.pageAfterMutation(state, request.signal, fallback)
      return this.commit({
        ...page,
        revision,
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
        const page = await this.page(state, request.signal)
        if (page.revision !== state.revision) return this.commit(page)
        return page
      } catch (error) {
        if (error instanceof BrowserRuntimeError && error.code === 'BROWSER_RUNTIME_UNAVAILABLE') {
          const reason = /HTTP request failed/.test(error.message) ? 'crashed' : 'unhealthy'
          return this.scheduleRecovery(reason, true) ?? this.states.get(browserTargetKey(request.target)) ?? state
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
      const { response, bytes } = await this.request('/screenshot', {
        method: 'GET',
        headers: { 'x-tab-id': this.upstreamTabId(request.target) },
      }, request.signal)
      if (response.headers.get('content-type')?.split(';', 1)[0] !== 'image/png') {
        throw new BrowserRuntimeError('Tandem screenshot response must be image/png', 'BROWSER_PROTOCOL')
      }
      return Object.freeze({
        target: state.target,
        revision: state.revision,
        url: page.url,
        title: page.title,
        mediaType: 'image/png' as const,
        data: Buffer.from(bytes).toString('base64'),
      })
    })
  }

  async focus(request: BrowserMutationRequest): Promise<BrowserPageState> {
    return this.mutateOpenPage(request, async (state) => {
      const response = objectValue(await this.json('/tabs/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tabId: this.upstreamTabId(request.target),
          expectedRevision: state.revision,
        }),
      }, request.signal), 'tab focus')
      if (response.ok !== true) throw new BrowserRuntimeError('Tandem did not focus the addressed tab', 'BROWSER_PROTOCOL')
      return this.commit({
        ...state,
        revision: numberField(response, 'revision', 'tab focus'),
        focused: true,
      })
    })
  }

  async input(request: BrowserInputRequest): Promise<BrowserPageState> {
    return this.mutateOpenPage(request, async (state) => {
      const response = objectValue(await this.json('/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session': this.sessionNameFor(request.target) },
        body: JSON.stringify({
          tabId: this.upstreamTabId(request.target),
          expectedRevision: state.revision,
          url: request.url,
          text: request.text,
        }),
      }, request.signal), 'input')
      if (response.ok !== true) throw new BrowserRuntimeError('Tandem did not apply input', 'BROWSER_PROTOCOL')
      return this.commit({
        ...state,
        revision: numberField(response, 'revision', 'input'),
        url: stringField(response, 'url', 'input'),
        title: textField(response, 'title', 'input'),
        text: textField(response, 'text', 'input'),
      })
    })
  }

  async close(request: BrowserMutationRequest): Promise<BrowserClosedState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(async () => {
      assertBrowserNotAborted(request.signal)
      const state = this.addressed(request.target)
      this.expectRevision(state, request.expectedRevision)
      if (state.status === 'closed') throw new BrowserRuntimeError('browser target is closed', 'BROWSER_NOT_OPEN')
      const profile = this.openProfile(request.target)
      const sessionName = profile.sessionName
      profile.tabs.delete(state.target.tabId)
      const lastTab = profile.tabs.size === 0
      // An unavailable target has no reachable runtime left to destroy; the
      // close is a local receipt. Reachability, not child ownership, gates the
      // HTTP destroy so the protocol-only client still cleans up its sessions.
      if (lastTab && state.status === 'open') {
        const response = objectValue(await this.json('/sessions/destroy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: sessionName }),
        }, request.signal), 'session destroy')
        if (response.ok !== true) throw new BrowserRuntimeError('Tandem did not destroy the session', 'BROWSER_PROTOCOL')
      }
      if (lastTab) this.profiles.delete(state.target.profileId)
      const closed = this.commit({ status: 'closed' as const, target: state.target, revision: state.revision + 1 })
      if (this.profiles.size === 0) await this.stopProcess()
      return closed
    })
  }

  /** Drain admitted work, close remaining Tandem sessions, and join the process tree. */
  private async teardown(): Promise<void> {
    this.closing = true
    await this.queue
    for (const state of [...this.states.values()]) {
      if (state.status !== 'open' && state.status !== 'unavailable') continue
      // Unavailable targets have no reachable runtime; only open sessions get
      // the best-effort HTTP destroy, whether or not a fixture child is owned.
      if (state.status === 'open') {
        try {
          const profile = this.profiles.get(state.target.profileId)
          if (profile !== undefined) {
            await this.json('/sessions/destroy', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: profile.sessionName }),
            }, undefined)
          }
        } catch (error) {
          this.ctx.logger.warn('browser-runtime-tandem: session cleanup failed before process teardown')
          this.ctx.logger.warn(error)
        }
      }
      this.commit({ status: 'closed', target: state.target, revision: state.revision + 1 })
    }
    this.profiles.clear()
    await this.stopProcess()
    this.disposed = true
  }
}

export default TandemBrowserRuntime
