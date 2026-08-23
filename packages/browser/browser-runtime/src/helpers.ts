/** Shared Provider helpers for the Browser Runtime capability. @module @deepseek-ai/dsh-browser-runtime */
import type { Context } from '@deepseek-ai/cordis'
import { BrowserInstanceId, BrowserProfileId, BrowserProfileName, BrowserRuntimeError, BrowserTabId, BrowserWorkspaceId } from './types.ts'
import type {
  BrowserCreateAttach,
  BrowserCreateRequest,
  BrowserPageState,
  BrowserProfileChrome,
  BrowserProfileKind,
  BrowserProfileStorage,
  BrowserRuntimeState,
  BrowserTarget,
} from './types.ts'

const PROFILE_NAME = /^(?!tmp(?:-|$)|shared$)[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** Reserved name of the installation-wide shared Browser Profile. */
export const SHARED_BROWSER_PROFILE_NAME = BrowserProfileName('shared')

/** Facts a Provider uses to project address-field chrome for one Profile. */
export interface BrowserProfileChromeRequest {
  readonly kind: BrowserProfileKind
  readonly name?: BrowserProfileName
  readonly sessionName: string
}

/**
 * Reject a Profile name that cannot be a stable Electron partition key.
 * @param name - Caller-visible persistent Profile name.
 * @returns the branded name when it is a valid partition key.
 */
export function assertBrowserProfileName(name: string): BrowserProfileName {
  if (!PROFILE_NAME.test(name)) {
    throw new BrowserRuntimeError(
      `browser Profile name is not a stable partition key: ${JSON.stringify(name)}`,
      'BROWSER_PROFILE_NAME',
    )
  }
  return BrowserProfileName(name)
}

/**
 * Map one Provider-owned session name to an Electron persist partition.
 * @param sessionName - Exact session name the Provider created.
 * @returns the `persist:session-*` partition that stores that named Profile's identity.
 */
export function browserSessionPartition(sessionName: string): string {
  return `persist:session-${sessionName}`
}

/**
 * Map one temporary Profile to an ephemeral Electron partition with no persist prefix.
 * @param sessionName - Exact session name the Provider created.
 * @returns the `session-*` partition that Chromium must not persist to disk.
 */
export function browserTemporaryPartition(sessionName: string): string {
  return `session-${sessionName}`
}

/**
 * Recover the Provider-owned session name from a persist or ephemeral partition.
 * @param partition - Committed chrome partition string.
 * @returns the session name encoded in that partition.
 */
export function browserSessionNameFromPartition(partition: string): string {
  if (partition.startsWith('persist:session-')) return partition.slice('persist:session-'.length)
  if (partition.startsWith('session-')) return partition.slice('session-'.length)
  throw new BrowserRuntimeError(`browser partition is not a session key: ${partition}`, 'BROWSER_PROTOCOL')
}

/**
 * Project address-field chrome for one committed Profile. Temporary Profiles omit a label.
 * @param request - Profile kind, optional name, and Provider-owned session name.
 * @returns chrome facts Dock can place near the address field without a second account concept.
 */
export function browserProfileChrome(request: BrowserProfileChromeRequest): BrowserProfileChrome {
  if (request.kind === 'temporary') {
    return Object.freeze({ kind: 'temporary', partition: browserTemporaryPartition(request.sessionName) })
  }
  if (request.kind === 'shared') {
    return Object.freeze({
      kind: 'shared',
      name: SHARED_BROWSER_PROFILE_NAME,
      partition: browserSessionPartition(request.sessionName),
    })
  }
  if (request.name === undefined) {
    throw new BrowserRuntimeError('a persistent Browser Profile requires a name', 'BROWSER_PROFILE_NAME')
  }
  return Object.freeze({
    kind: 'persistent',
    name: request.name,
    partition: browserSessionPartition(request.sessionName),
  })
}

/**
 * Read the address-field label for one Profile, if any.
 * @param chrome - Committed chrome facts.
 * @returns the persistent or shared Profile name, or `undefined` for a temporary Profile.
 */
export function labeledBrowserProfileName(chrome: BrowserProfileChrome): BrowserProfileName | undefined {
  return chrome.kind === 'persistent' || chrome.kind === 'shared' ? chrome.name : undefined
}

/**
 * Whether this Profile kind retains partition-backed identity after close.
 * @param kind - Committed chrome kind.
 * @returns true for named persistent and shared Profiles.
 */
export function browserProfileRetainsIdentity(kind: BrowserProfileKind): boolean {
  return kind === 'persistent' || kind === 'shared'
}

/** Resolved create facts for one temporary, named persistent, or shared Profile. */
export interface ResolvedBrowserProfileCreate {
  readonly profileId: BrowserProfileId
  readonly sessionName: string
  readonly chrome: BrowserProfileChrome
}

/** Empty identity retained only while a temporary Profile is open. */
export const EMPTY_BROWSER_PROFILE_STORAGE: BrowserProfileStorage = Object.freeze({
  cookies: '',
  localStorage: '',
  indexedDb: '',
  cache: '',
  serviceWorker: '',
})

/**
 * Build one Profile hierarchy around a session name and tab sequence.
 * @param profileId - Opaque Profile identity.
 * @param sessionName - Provider-owned partition identifier.
 * @param tabSeq - Positive sequence that distinguishes one open tab lifecycle.
 * @param attach - Optional existing Workspace or browser instance to reuse.
 * @param workspaceSeq - Distinct Workspace sequence for a shared Profile without attach.
 * @returns the frozen target for that open lifecycle.
 */
export function browserTargetFor(
  profileId: BrowserProfileId,
  sessionName: string,
  tabSeq: number,
  attach?: BrowserCreateAttach,
  workspaceSeq?: number,
): BrowserTarget {
  return Object.freeze({
    profileId,
    workspaceId: attach?.workspaceId ?? BrowserWorkspaceId(
      workspaceSeq === undefined
        ? `${sessionName}-workspace`
        : `${sessionName}-workspace-${String(workspaceSeq)}`,
    ),
    browserId: attach?.kind === 'browser'
      ? attach.browserId
      : BrowserInstanceId(`${sessionName}-browser-${String(tabSeq)}`),
    tabId: BrowserTabId(`${sessionName}-tab-${String(tabSeq)}`),
  })
}

/**
 * Allocate a Workspace sequence when opening another shared-Profile Workspace.
 * @param states - Current Provider states.
 * @param profileId - Shared Profile identity.
 * @param attach - Existing hierarchy, when the caller named one.
 * @returns a positive sequence for a new Workspace, or undefined when attach is set.
 */
export function browserSharedWorkspaceSeq(
  states: Iterable<BrowserRuntimeState>,
  profileId: BrowserProfileId,
  attach: BrowserCreateAttach | undefined,
): number | undefined {
  if (attach !== undefined) return undefined
  const workspaces = new Set(
    [...states]
      .filter(state => state.target.profileId === profileId)
      .map(state => state.target.workspaceId),
  )
  return workspaces.size + 1
}

/**
 * Compare only the Workspace identity of two targets.
 * @param left - First target.
 * @param right - Second target.
 * @returns whether both targets address the same Browser Workspace.
 */
export function sameBrowserWorkspace(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.profileId === right.profileId && left.workspaceId === right.workspaceId
}

/**
 * Compare only the browser-instance identity of two targets.
 * @param left - First target.
 * @param right - Second target.
 * @returns whether both targets address the same browser instance.
 */
export function sameBrowserInstance(left: BrowserTarget, right: BrowserTarget): boolean {
  return sameBrowserWorkspace(left, right) && left.browserId === right.browserId
}

/**
 * Compare only the Profile identity of two targets.
 * @param left - First target.
 * @param right - Second target.
 * @returns whether both targets address the same Browser Profile.
 */
export function sameBrowserProfile(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.profileId === right.profileId
}

/**
 * Resolve the open page that an attach request names.
 * @param states - Current Provider states.
 * @param attach - Existing Workspace or browser instance to reuse.
 * @returns the open page when attach is present, otherwise `undefined`.
 */
export function resolveBrowserCreateAttach(
  states: Iterable<BrowserRuntimeState>,
  attach: BrowserCreateAttach | undefined,
): BrowserPageState | undefined {
  if (attach === undefined) return undefined
  const attached = [...states].find((state): state is BrowserPageState => (
    state.status === 'open' && state.target.workspaceId === attach.workspaceId
  ))
  if (attached === undefined) {
    throw new BrowserRuntimeError('browser attach target is not present', 'BROWSER_NOT_FOUND')
  }
  return attached
}

/**
 * Reject an attach request that names a missing or closed hierarchy.
 * @param states - Current Provider states.
 * @param profileId - Profile identity of the incoming create.
 * @param attach - Existing Workspace or browser instance to reuse.
 */
export function assertBrowserCreateAttach(
  states: Iterable<BrowserRuntimeState>,
  profileId: BrowserProfileId,
  attach: BrowserCreateAttach | undefined,
): void {
  if (attach === undefined) return
  const open = [...states].filter(state => state.status === 'open' && state.target.profileId === profileId)
  const workspace = open.find(state => state.target.workspaceId === attach.workspaceId)
  if (workspace === undefined) {
    throw new BrowserRuntimeError('browser attach target is not present', 'BROWSER_NOT_FOUND')
  }
  if (attach.kind === 'browser' && !open.some(state => state.target.browserId === attach.browserId)) {
    throw new BrowserRuntimeError('browser attach target is not present', 'BROWSER_NOT_FOUND')
  }
}

/**
 * Build partition-backed identity facts for one Profile.
 * @param token - Stable identity written into every storage slot, or empty to wipe.
 * @returns frozen storage facts for cookies, localStorage, IndexedDB, cache, and service workers.
 */
export function browserProfileStorage(token: string): BrowserProfileStorage {
  return Object.freeze({
    cookies: `profile=${token}`,
    localStorage: token,
    indexedDb: token,
    cache: token,
    serviceWorker: token,
  })
}

/**
 * Resolve opaque Profile identity, partition identifier, and chrome for one create request.
 * @param prefix - Provider-owned identity prefix.
 * @param request - Temporary, named persistent, or shared create request.
 * @param temporarySeq - Positive sequence used only for a temporary Profile.
 * @returns stable named-Profile facts, unique disposable facts, or the shared Profile facts.
 */
export function resolveBrowserProfileCreate(
  prefix: string,
  request:
    | { readonly profile: 'temporary' }
    | { readonly profile: 'persistent'; readonly name: string }
    | { readonly profile: 'shared' },
  temporarySeq: number,
): ResolvedBrowserProfileCreate {
  if (request.profile === 'temporary') {
    const sessionName = `${prefix}-tmp-${String(temporarySeq)}`
    return Object.freeze({
      profileId: BrowserProfileId(sessionName),
      sessionName,
      chrome: browserProfileChrome({ kind: 'temporary', sessionName }),
    })
  }
  if (request.profile === 'shared') {
    const sessionName = `${prefix}-shared`
    return Object.freeze({
      profileId: BrowserProfileId(`${prefix}-profile-shared`),
      sessionName,
      chrome: browserProfileChrome({ kind: 'shared', sessionName }),
    })
  }
  const name = assertBrowserProfileName(request.name)
  const sessionName = `${prefix}-${name}`
  return Object.freeze({
    profileId: BrowserProfileId(`${prefix}-profile-${name}`),
    sessionName,
    chrome: browserProfileChrome({ kind: 'persistent', name, sessionName }),
  })
}

/**
 * Compare all four opaque identities without exposing Provider structure.
 * @param left - First target.
 * @param right - Second target.
 * @returns whether both values address the same Profile, Workspace, browser, and tab.
 */
export function sameBrowserTarget(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.profileId === right.profileId
    && left.workspaceId === right.workspaceId
    && left.browserId === right.browserId
    && left.tabId === right.tabId
}

/**
 * Serialize one target into a stable map key.
 * @param target - Opaque identities for one tab lifecycle.
 * @returns a key that distinguishes Profile, Workspace, browser, and tab.
 */
export function browserTargetKey(target: BrowserTarget): string {
  return `${target.profileId}\0${target.workspaceId}\0${target.browserId}\0${target.tabId}`
}

/**
 * Reject already-aborted work before it reaches Provider state.
 * @param signal - Caller cancellation, if any.
 */
export function assertBrowserNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BrowserRuntimeError(`browser operation aborted: ${String(signal.reason)}`, 'BROWSER_ABORTED')
  }
}

/**
 * Serialize one accepted operation behind earlier queued work.
 * @param queue - Tail of the Provider's operation queue.
 * @param assertAccepting - Throws `BROWSER_DISPOSED` after teardown begins.
 * @param operation - Work to run after earlier operations settle.
 * @returns the operation promise and the next queue tail.
 */
export function enqueueBrowserRuntimeOperation<T>(
  queue: Promise<void>,
  assertAccepting: () => void,
  operation: () => T | Promise<T>,
): { readonly result: Promise<T>; readonly queue: Promise<void> } {
  assertAccepting()
  const result = queue.then(operation)
  return {
    result,
    queue: result.then(() => undefined, () => undefined),
  }
}

/**
 * Publish one committed state while containing every post-commit observer failure.
 * @param ctx - Host context whose `browser/runtime-state` listeners receive the state.
 * @param state - Frozen committed state.
 * @param warn - Logs one contained observer failure.
 */
export function emitBrowserRuntimeState(
  ctx: Context,
  state: BrowserRuntimeState,
  warn: (error: unknown) => void,
): void {
  const args = ['browser/runtime-state', state]
  for (const listener of ctx.events.dispatch('emit', args) as Array<(value: BrowserRuntimeState) => unknown>) {
    try {
      const returned = listener(state)
      if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, warn)
      }
    } catch (error) {
      warn(error)
    }
  }
}

/**
 * Resolve the addressed Provider state or reject an unknown target.
 * @param state - Current Provider state, if any.
 * @param target - Opaque identities from the caller.
 * @returns the current state when it addresses `target`.
 */
export function addressedBrowserRuntimeState(
  state: BrowserRuntimeState | undefined,
  target: BrowserTarget,
): BrowserRuntimeState {
  if (state === undefined || !sameBrowserTarget(state.target, target)) {
    throw new BrowserRuntimeError('browser target is not present', 'BROWSER_NOT_FOUND')
  }
  return state
}

/**
 * Resolve one addressed state from a target-keyed map.
 * @param states - Authoritative states keyed by {@link browserTargetKey}.
 * @param target - Opaque identities from the caller.
 * @returns the current state when it addresses `target`.
 */
export function addressedBrowserRuntimeStateFrom(
  states: ReadonlyMap<string, BrowserRuntimeState>,
  target: BrowserTarget,
): BrowserRuntimeState {
  return addressedBrowserRuntimeState(states.get(browserTargetKey(target)), target)
}

/**
 * Freeze, validate, store, and publish one committed Browser Runtime state.
 * @param states - Authoritative states keyed by {@link browserTargetKey}.
 * @param validate - Optional pre-commit validator.
 * @param notify - Publishes the committed state.
 * @param state - Next state to commit.
 * @returns the frozen committed state.
 */
export function commitBrowserRuntimeState<T extends BrowserRuntimeState>(
  states: Map<string, BrowserRuntimeState>,
  validate: ((state: BrowserRuntimeState) => undefined) | undefined,
  notify: (state: BrowserRuntimeState) => void,
  state: T,
): T {
  const committed = Object.freeze(state) as T
  validate?.(committed)
  states.set(browserTargetKey(committed.target), committed)
  notify(committed)
  return committed
}

/**
 * Reject a second open writer of the same named persist partition.
 * @param states - Current Provider states.
 * @param partition - Persist partition claimed by the incoming named Profile.
 * @param name - Caller-visible Profile name used in the failure.
 */
export function assertBrowserProfileWriterAvailable(
  states: Iterable<BrowserRuntimeState>,
  partition: string,
  name: string,
): void {
  for (const state of states) {
    if (state.status === 'open' && state.chrome.kind === 'persistent' && state.chrome.partition === partition) {
      throw new BrowserRuntimeError(
        `browser Profile ${JSON.stringify(name)} already has a writer`,
        'BROWSER_PROFILE_BUSY',
      )
    }
  }
}

/**
 * Open pages currently written on one Profile.
 * @param states - Current Provider states.
 * @param profileId - Profile identity to collect.
 * @returns the open pages owned by that Profile.
 */
export function openBrowserPagesForProfile(
  states: Iterable<BrowserRuntimeState>,
  profileId: BrowserProfileId,
): BrowserPageState[] {
  return [...states].filter((state): state is BrowserPageState => (
    state.status === 'open' && state.target.profileId === profileId
  ))
}

/**
 * Reject a second unattached writer of a named persistent Profile.
 * @param states - Current Provider states.
 * @param request - Incoming create request.
 * @param partition - Persist partition claimed by the incoming named Profile.
 */
export function assertUnattachedPersistentWriterAvailable(
  states: Iterable<BrowserRuntimeState>,
  request: BrowserCreateRequest,
  partition: string,
): void {
  if (request.profile !== 'persistent' || request.attach !== undefined) return
  assertBrowserProfileWriterAvailable(states, partition, request.name)
}

/**
 * Narrow one addressed state to an open page.
 * @param state - Current addressed state.
 * @returns the open page when `status` is `open`.
 */
export function requireOpenBrowserPage(state: BrowserRuntimeState): BrowserPageState {
  if (state.status !== 'open') {
    throw new BrowserRuntimeError('browser target is closed', 'BROWSER_NOT_OPEN')
  }
  return state
}

/**
 * Reject a stale mutation whose expected revision is not current.
 * @param state - Current addressed state.
 * @param revision - Caller-supplied expected revision.
 */
export function requireExpectedBrowserRevision(
  state: BrowserRuntimeState,
  revision: number,
): void {
  if (state.revision !== revision) {
    throw new BrowserRuntimeError(
      `browser revision conflict: expected ${String(revision)}, current ${String(state.revision)}; observe again before mutating`,
      'BROWSER_REVISION_CONFLICT',
    )
  }
}

/**
 * Reject a stale mutation and return the addressed open page.
 * @param state - Current addressed state.
 * @param revision - Caller-supplied expected revision.
 * @returns the open page when the revision matches.
 */
export function requireExpectedOpenBrowserPage(
  state: BrowserRuntimeState,
  revision: number,
): BrowserPageState {
  requireExpectedBrowserRevision(state, revision)
  return requireOpenBrowserPage(state)
}
