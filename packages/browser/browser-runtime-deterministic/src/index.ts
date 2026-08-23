/**
 * Deterministic keyless Browser Runtime Provider for temporary, named persistent, and shared Profiles.
 * @module @deepseek-ai/dsh-browser-runtime-deterministic
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  addressedBrowserRuntimeStateFrom,
  assertBrowserCreateAttach,
  assertBrowserNotAborted,
  assertUnattachedPersistentWriterAvailable,
  browserProfileStorage,
  BrowserRuntime,
  BrowserRuntimeError,
  browserSessionNameFromPartition,
  browserTargetFor,
  commitBrowserRuntimeState,
  emitBrowserRuntimeState,
  EMPTY_BROWSER_PROFILE_STORAGE,
  openBrowserPagesForProfile,
  requireExpectedBrowserRevision,
  requireOpenBrowserPage,
  resolveBrowserCreateAttach,
  resolveBrowserProfileCreate,
  browserProfileRetainsIdentity,
  browserSharedWorkspaceSeq,
} from '@deepseek-ai/dsh-browser-runtime'
import type {
  BrowserClosedState,
  BrowserCreateAttach,
  BrowserCreateRequest,
  ResolvedBrowserProfileCreate,
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
import {
  registerRuntimeStateReader,
  RUNTIME_STATE_OWNER,
  runtimeStateValidator,
  type RuntimeStateOwner,
} from './runtime-state.ts'

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** One URL and its deterministic observable and screenshot facts. */
export interface DeterministicBrowserPage {
  /** Exact URL accepted by `navigate`. */
  url: string
  /** Page title returned by observations. */
  title: string
  /** Page text returned by observations. */
  text: string
  /** Non-empty canonical base64 whose decoded bytes start with the PNG signature. */
  screenshotPngBase64: string
}

/** Deterministic Provider configuration. */
export interface Config {
  /** Prefix used for the four stable opaque identities. */
  idPrefix?: string
  /** Complete pages this keyless Provider can navigate to. */
  pages: DeterministicBrowserPage[]
}

/** Runtime configuration schema for the deterministic Browser Runtime Provider. */
export const Config: z<Config> = z.object({
  idPrefix: z.string().min(1).default('browser-trace'),
  pages: z.array(z.object({
    url: z.string().min(1).required(),
    title: z.string().min(1).required(),
    text: z.string().required(),
    screenshotPngBase64: z.string().min(1).required(),
  })).required(),
})

/** Complete config after Schemastery applies its defaults. */
type ResolvedConfig = Required<Config>

/** Partition-backed page identity retained for a named Profile after close. */
interface PersistedProfile {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly storage: BrowserProfileStorage
  readonly chrome: BrowserProfileChrome
  readonly sessionName: string
  readonly tabSeq: number
}

/** Decode one canonical, non-empty PNG fixture or fail Provider loading. */
function validateScreenshot(url: string, value: string): void {
  if (value.length === 0 || !CANONICAL_BASE64.test(value)) {
    throw new Error(
      `browser-runtime-deterministic: page ${JSON.stringify(url)} screenshotPngBase64 must be non-empty canonical base64 data`,
    )
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) {
    throw new Error(
      `browser-runtime-deterministic: page ${JSON.stringify(url)} screenshotPngBase64 must be non-empty canonical base64 data`,
    )
  }
  if (bytes.length < PNG_SIGNATURE.length
    || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error(
      `browser-runtime-deterministic: page ${JSON.stringify(url)} screenshotPngBase64 must contain PNG data`,
    )
  }
}

/**
 * Multi-Profile deterministic Browser Runtime. Every operation enters one serialized queue;
 * mutations require the last observed revision of the addressed target, run the package
 * invariant before assignment, and publish only committed state.
 */
export class DeterministicBrowserRuntime extends BrowserRuntime {
  static Config = Config

  /** Package-private identity for this concrete Provider generation. */
  readonly [RUNTIME_STATE_OWNER]: RuntimeStateOwner = Object.freeze({})

  private readonly pages: ReadonlyMap<string, DeterministicBrowserPage>
  private readonly idPrefix: string
  private readonly states = new Map<string, BrowserRuntimeState>()
  private readonly persisted = new Map<string, PersistedProfile>()
  private temporarySeq = 0

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (resolved.pages.length === 0) {
      throw new Error('browser-runtime-deterministic: config.pages must contain at least one page')
    }
    const pages = new Map<string, DeterministicBrowserPage>()
    for (const page of resolved.pages) {
      if (pages.has(page.url)) {
        throw new Error(`browser-runtime-deterministic: duplicate page URL ${JSON.stringify(page.url)}`)
      }
      validateScreenshot(page.url, page.screenshotPngBase64)
      pages.set(page.url, Object.freeze({ ...page }))
    }
    this.pages = pages
    this.idPrefix = resolved.idPrefix
    ctx.effect(
      () => registerRuntimeStateReader(this[RUNTIME_STATE_OWNER], () => this.states),
      'deterministic browser runtime state reader',
    )
    ctx.effect(() => () => this.teardown(), 'deterministic browser runtime teardown')
  }

  /** Publish one committed state while containing every post-commit observer failure. */
  private notifyState(state: BrowserRuntimeState): void {
    emitBrowserRuntimeState(this.ctx, state, (error) => {
      this.warnStateObserverFailure(error)
    })
  }

  /** Log one contained state-observer failure without reading it through an unsafe coercion. */
  private warnStateObserverFailure(error: unknown): void {
    this.ctx.logger.warn('browser-runtime-deterministic: a browser/runtime-state observer failed')
    this.ctx.logger.warn(error)
  }

  /** Validate and assign one authoritative state, then notify non-vetoing observers. */
  private commit<T extends BrowserRuntimeState>(state: T): T {
    return commitBrowserRuntimeState(
      this.states,
      runtimeStateValidator(this[RUNTIME_STATE_OWNER]),
      (committed) => { this.notifyState(committed) },
      state,
    )
  }

  /** Resolve and validate the addressed state. */
  private addressed(target: BrowserTarget): BrowserRuntimeState {
    return addressedBrowserRuntimeStateFrom(this.states, target)
  }

  /** Resolve an open page or reject a closed target. */
  protected override openPage(target: BrowserTarget): BrowserPageState {
    return requireOpenBrowserPage(this.addressed(target))
  }

  /** Enforce optimistic mutation ordering. */
  protected override expectRevision(state: BrowserRuntimeState, revision: number): void {
    requireExpectedBrowserRevision(state, revision)
  }

  async create(request: BrowserCreateRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      if (request.profile === 'temporary') {
        const attached = resolveBrowserCreateAttach(this.states.values(), request.attach)
        if (attached === undefined) this.temporarySeq += 1
        const created = attached === undefined
          ? resolveBrowserProfileCreate(this.idPrefix, request, this.temporarySeq)
          : {
            profileId: attached.target.profileId,
            sessionName: browserSessionNameFromPartition(attached.chrome.partition),
            chrome: attached.chrome,
          }
        const existing = openBrowserPagesForProfile(this.states.values(), created.profileId)
        const tabSeq = existing.length + 1
        assertBrowserCreateAttach(this.states.values(), created.profileId, request.attach)
        return this.commitBlank(created, tabSeq, request.attach)
      }
      const created = resolveBrowserProfileCreate(this.idPrefix, request, this.temporarySeq)
      const existing = openBrowserPagesForProfile(this.states.values(), created.profileId)
      assertUnattachedPersistentWriterAvailable(this.states.values(), request, created.chrome.partition)
      assertBrowserCreateAttach(this.states.values(), created.profileId, request.attach)
      const stored = this.persisted.get(created.sessionName)
      const historical = [...this.states.values()].filter(state => state.target.profileId === created.profileId)
      const tabSeq = stored === undefined ? historical.length + 1 : stored.tabSeq + existing.length + 1
      const workspaceSeq = request.profile === 'shared'
        ? browserSharedWorkspaceSeq(this.states.values(), created.profileId, request.attach)
        : undefined
      const sibling = existing.find(state => state.storage.cookies !== '')
      if (stored !== undefined) {
        return this.commit({
          status: 'open',
          target: browserTargetFor(
            created.profileId, created.sessionName, tabSeq, request.attach, workspaceSeq,
          ),
          revision: 0,
          url: stored.url,
          title: stored.title,
          text: stored.text,
          focused: false,
          chrome: stored.chrome,
          storage: stored.storage,
        })
      }
      if (sibling !== undefined) {
        return this.commit({
          status: 'open',
          target: browserTargetFor(
            created.profileId, created.sessionName, tabSeq, request.attach, workspaceSeq,
          ),
          revision: 0,
          url: sibling.url,
          title: sibling.title,
          text: sibling.text,
          focused: false,
          chrome: sibling.chrome,
          storage: sibling.storage,
        })
      }
      return this.commitBlank(created, tabSeq, request.attach, workspaceSeq)
    })
  }

  /** Commit a blank open page for a newly created or attached tab. */
  private commitBlank(
    created: ResolvedBrowserProfileCreate,
    tabSeq: number,
    attach: BrowserCreateAttach | undefined,
    workspaceSeq?: number,
  ): BrowserPageState {
    return this.commit({
      status: 'open',
      target: browserTargetFor(created.profileId, created.sessionName, tabSeq, attach, workspaceSeq),
      revision: 0,
      url: 'about:blank',
      title: 'New Tab',
      text: '',
      focused: false,
      chrome: created.chrome,
      storage: EMPTY_BROWSER_PROFILE_STORAGE,
    })
  }

  async navigate(request: BrowserNavigateRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      const page = this.pages.get(request.url)
      if (page === undefined) {
        throw new BrowserRuntimeError(`deterministic browser page is not configured: ${request.url}`, 'BROWSER_UNKNOWN_URL')
      }
      const storage = browserProfileRetainsIdentity(state.chrome.kind) && state.chrome.name !== undefined
        ? browserProfileStorage(state.chrome.name)
        : EMPTY_BROWSER_PROFILE_STORAGE
      return this.commit({
        status: 'open',
        target: state.target,
        revision: state.revision + 1,
        url: page.url,
        title: page.title,
        text: page.text,
        focused: state.focused,
        chrome: state.chrome,
        storage,
      })
    })
  }

  async observe(request: BrowserObserveRequest): Promise<BrowserRuntimeState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      return this.addressed(request.target)
    })
  }

  async screenshot(request: BrowserObserveRequest): Promise<BrowserScreenshot> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      const page = this.pages.get(state.url)
      if (page === undefined) {
        throw new BrowserRuntimeError(`deterministic browser page is not configured: ${state.url}`, 'BROWSER_UNKNOWN_URL')
      }
      return Object.freeze({
        target: state.target,
        revision: state.revision,
        url: state.url,
        title: state.title,
        mediaType: 'image/png' as const,
        data: page.screenshotPngBase64,
      })
    })
  }

  async focus(request: BrowserMutationRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      return this.commit({ ...state, revision: state.revision + 1, focused: true })
    })
  }

  async input(request: BrowserInputRequest): Promise<BrowserPageState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      if (request.url === undefined) {
        return this.commit({
          ...state,
          revision: state.revision + 1,
          text: request.text,
        })
      }
      const page = this.pages.get(request.url)
      if (page === undefined) {
        throw new BrowserRuntimeError(
          `deterministic browser page is not configured: ${request.url}`,
          'BROWSER_UNKNOWN_URL',
        )
      }
      return this.commit({
        ...state,
        revision: state.revision + 1,
        url: request.url,
        title: page.title,
        text: request.text ?? page.text,
      })
    })
  }

  async close(request: BrowserMutationRequest): Promise<BrowserClosedState> {
    assertBrowserNotAborted(request.signal)
    return this.exclusive(() => {
      assertBrowserNotAborted(request.signal)
      const state = this.openPage(request.target)
      this.expectRevision(state, request.expectedRevision)
      this.rememberPersistent(state)
      return this.commit({ status: 'closed', target: state.target, revision: state.revision + 1 })
    })
  }

  /** Snapshot one identity-retaining Profile so a later create can restore it. */
  private rememberPersistent(state: BrowserPageState): void {
    if (!browserProfileRetainsIdentity(state.chrome.kind)) return
    const sessionName = browserSessionNameFromPartition(state.chrome.partition)
    const previous = this.persisted.get(sessionName)
    this.persisted.set(sessionName, Object.freeze({
      url: state.url,
      title: state.title,
      text: state.text,
      storage: state.storage,
      chrome: state.chrome,
      sessionName,
      tabSeq: (previous?.tabSeq ?? 0) + 1,
    }))
  }

  /** Finish accepted operations, close every open Profile, then drop persist memory. */
  private async teardown(): Promise<void> {
    this.closing = true
    await this.queue
    for (const state of [...this.states.values()]) {
      if (state.status === 'open') {
        this.rememberPersistent(state)
        this.commit({ status: 'closed', target: state.target, revision: state.revision + 1 })
      }
    }
    this.persisted.clear()
    this.disposed = true
  }
}

export default DeterministicBrowserRuntime
