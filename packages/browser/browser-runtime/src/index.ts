/** Provider-neutral Service Definition for the Browser Runtime capability. @module @deepseek-ai/dsh-browser-runtime */

import { Context, Service } from '@deepseek-ai/cordis'
import { enqueueBrowserRuntimeOperation } from './helpers.ts'
import { BrowserRuntimeError } from './types.ts'
import type {
  BrowserClosedState,
  BrowserCreateRequest,
  BrowserInputRequest,
  BrowserMutationRequest,
  BrowserNavigateRequest,
  BrowserObserveRequest,
  BrowserPageState,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
} from './types.ts'

export {
  addressedBrowserRuntimeState,
  addressedBrowserRuntimeStateFrom,
  assertBrowserCreateAttach,
  assertBrowserNotAborted,
  assertBrowserProfileName,
  assertBrowserProfileWriterAvailable,
  assertUnattachedPersistentWriterAvailable,
  browserProfileChrome,
  browserProfileRetainsIdentity,
  browserProfileStorage,
  browserSharedWorkspaceSeq,
  browserSessionNameFromPartition,
  browserSessionPartition,
  browserTemporaryPartition,
  browserTargetFor,
  browserTargetKey,
  commitBrowserRuntimeState,
  emitBrowserRuntimeState,
  enqueueBrowserRuntimeOperation,
  labeledBrowserProfileName,
  openBrowserPagesForProfile,
  requireExpectedBrowserRevision,
  requireExpectedOpenBrowserPage,
  requireOpenBrowserPage,
  resolveBrowserCreateAttach,
  resolveBrowserProfileCreate,
  SHARED_BROWSER_PROFILE_NAME,
  sameBrowserInstance,
  sameBrowserProfile,
  sameBrowserTarget,
  sameBrowserWorkspace,
} from './helpers.ts'
export { EMPTY_BROWSER_PROFILE_STORAGE } from './helpers.ts'
export type { BrowserProfileChromeRequest, ResolvedBrowserProfileCreate } from './helpers.ts'
export {
  BrowserInstanceId,
  BrowserProfileId,
  BrowserProfileName,
  BrowserRuntimeError,
  BrowserTabId,
  BrowserWorkspaceId,
} from './types.ts'
export type {
  BrowserClosedState,
  BrowserCreateAttach,
  BrowserCreateRequest,
  BrowserDockWidth,
  BrowserInputRequest,
  BrowserMutationRequest,
  BrowserNavigateRequest,
  BrowserObserveRequest,
  BrowserPageState,
  BrowserPersistentCreateRequest,
  BrowserSharedCreateRequest,
  BrowserProfileChrome,
  BrowserProfileKind,
  BrowserProfileStorage,
  BrowserRuntimeErrorCode,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
  BrowserTemporaryCreateRequest,
  BrowserUnavailableState,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserRuntime: BrowserRuntime
  }

  interface Events {
    /**
     * Post-commit Browser Runtime lifecycle notification. Providers contain synchronous throws and
     * asynchronous rejections from each listener, continue the fan-out, and never change a committed
     * operation's outcome; returned promises are observed but not awaited.
     * @mode emit
     * @param state - Complete committed state after the operation.
     */
    'browser/runtime-state'(state: BrowserRuntimeState): void
  }
}

/**
 * Browser Runtime Service Definition. Providers serialize every operation, own target lifecycles,
 * and reject stale mutations. Callers retain returned targets and revisions but do not dispose
 * Provider resources directly. A method resolves only after its state commit and synchronous
 * post-commit notification attempts; asynchronous observers are not awaited.
 */
export abstract class BrowserRuntime extends Service {
  /** Tail of the serialized Provider operation queue. */
  protected queue: Promise<void> = Promise.resolve()
  /** True once Provider teardown has started. */
  protected closing = false
  /** True after teardown has joined outstanding work. */
  protected disposed = false

  constructor(ctx: Context) {
    super(ctx, 'browserRuntime')
  }

  /** Reject work that enters after teardown begins. */
  protected assertAccepting(): void {
    if (this.closing || this.disposed) {
      throw new BrowserRuntimeError('browser runtime is disposed', 'BROWSER_DISPOSED')
    }
  }

  /**
   * Serialize one accepted operation behind earlier queued work.
   * @param operation - Work to run after earlier operations settle.
   * @returns the operation result.
   */
  protected exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = enqueueBrowserRuntimeOperation(this.queue, () => {
      this.assertAccepting()
    }, operation)
    this.queue = next.queue
    return next.result
  }

  /**
   * Resolve the addressed open page or reject a closed or unavailable target.
   * @param target - Opaque identities from the caller.
   * @returns the current open page.
   */
  protected abstract openPage(target: BrowserTarget): BrowserPageState
  /**
   * Reject a mutation whose expected revision is not the current one.
   * @param state - Current addressed state.
   * @param revision - Caller-supplied expected revision.
   */
  protected abstract expectRevision(state: BrowserRuntimeState, revision: number): void
  /**
   * Create one temporary, named persistent, or shared Profile tab. Omitting `attach` starts a new
   * Workspace and browser instance. Attaching to a Workspace starts another instance; attaching to a
   * browser instance starts another tab in that instance.
   * @param request - Temporary, named persistent, or shared Profile request, optional attach, and
   * cancellation.
   * @returns initial open page state at revision zero; its target addresses every later operation in
   * this lifecycle. Persistent and shared Profiles restore the same storage partition on later
   * creates. Shared creates from different Sessions reuse one partition and do not take
   * `BROWSER_PROFILE_BUSY`.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED` when cancellation wins, `BROWSER_DISPOSED`
   * after teardown starts, `BROWSER_NOT_FOUND` when `attach` names a missing hierarchy,
   * `BROWSER_PROFILE_BUSY` when the named persistent Profile already has a writer,
   * `BROWSER_PROFILE_NAME` when the name cannot be a stable partition key, `BROWSER_PROTOCOL` when
   * the upstream runtime breaks its response protocol, or `BROWSER_RUNTIME_UNAVAILABLE` when the
   * upstream runtime cannot be reached or starts unhealthy.
   */
  abstract create(request: BrowserCreateRequest): Promise<BrowserPageState>
  /**
   * Navigate the addressed tab after checking its expected revision.
   * @param request - Target, expected revision, URL, and cancellation signal.
   * @returns committed open page state whose revision replaces the caller's prior revision.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
   * `BROWSER_NOT_OPEN`, `BROWSER_REVISION_CONFLICT`, or `BROWSER_UNKNOWN_URL` when the corresponding
   * precondition fails before commit, `BROWSER_PROTOCOL` when the upstream runtime breaks its
   * response protocol, or `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
   */
  abstract navigate(request: BrowserNavigateRequest): Promise<BrowserPageState>
  /**
   * Observe the latest open or closed state for one target.
   * @param request - Target and cancellation signal.
   * @returns current open, unavailable, or closed state after earlier queued operations. Read-only
   * observation does not advance the revision; an external Provider crash or reconnect may do so.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, or
   * `BROWSER_NOT_FOUND`; a closed target is returned rather than rejected, and an unavailable
   * upstream runtime is returned as its unavailable state. `BROWSER_PROTOCOL` is rejected when the
   * upstream runtime breaks its response protocol.
   */
  abstract observe(request: BrowserObserveRequest): Promise<BrowserRuntimeState>
  /**
   * Capture PNG bytes for the addressed open tab.
   * @param request - Target and cancellation signal.
   * @returns screenshot bytes and depicted page facts from one serialized read at the current revision.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
   * `BROWSER_NOT_OPEN`, or `BROWSER_UNKNOWN_URL` when the Provider cannot depict the addressed open
   * page, `BROWSER_PROTOCOL` when the upstream runtime breaks its response protocol, or
   * `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
   */
  abstract screenshot(request: BrowserObserveRequest): Promise<BrowserScreenshot>
  /**
   * Focus the addressed tab after checking its expected revision.
   * @param request - Target, expected revision, and cancellation signal.
   * @returns committed focused page state whose revision replaces the caller's prior revision.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
   * `BROWSER_NOT_OPEN`, or `BROWSER_REVISION_CONFLICT` when the corresponding precondition fails
   * before commit, `BROWSER_PROTOCOL` when the upstream runtime breaks its response protocol, or
   * `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
   */
  abstract focus(request: BrowserMutationRequest): Promise<BrowserPageState>
  /**
   * Apply synthetic Agent input after checking the expected revision.
   * @param request - Target, expected revision, URL or page text, and cancellation.
   * @returns committed open page whose revision replaces the caller's prior revision. Session,
   * Profile, browser instance, and tab identities stay the same.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
   * `BROWSER_NOT_OPEN`, `BROWSER_REVISION_CONFLICT`, or `BROWSER_UNKNOWN_URL` when the
   * corresponding precondition fails before commit, `BROWSER_PROTOCOL` when the upstream runtime
   * breaks its response protocol, or `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
   */
  abstract input(request: BrowserInputRequest): Promise<BrowserPageState>
  /**
   * Close the addressed tab after checking its expected revision. Temporary Profiles discard
   * identity; persistent Profiles keep the named storage partition.
   * @param request - Target, expected revision, and cancellation signal.
   * @returns terminal close receipt retained by the Provider for later observation.
   * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
   * `BROWSER_NOT_OPEN`, or `BROWSER_REVISION_CONFLICT` when the corresponding precondition fails
   * before commit, `BROWSER_PROTOCOL` when the upstream runtime breaks its response protocol, or
   * `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
   */
  abstract close(request: BrowserMutationRequest): Promise<BrowserClosedState>
}

export default BrowserRuntime
