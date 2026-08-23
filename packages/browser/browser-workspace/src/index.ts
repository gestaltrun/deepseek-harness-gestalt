/**
 * Session-owned Browser Workspace binder. Each Session independently owns
 * zero or more Workspaces; each Workspace uses one Browser Profile and
 * contains multiple browser instances and tabs. Each tab's last committed
 * revision is a Session fact. `browser/runtime-state` also writes revision
 * advances for an owned, unclosed tab.
 * @module @deepseek-ai/dsh-browser-workspace
 */

import { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { BrowserRuntimeError } from '@deepseek-ai/dsh-browser-runtime'
import {
  BrowserProfileName,
  type BrowserClosedState,
  type BrowserCreateAttach,
  type BrowserCreateRequest,
  type BrowserInputRequest,
  type BrowserMutationRequest,
  type BrowserNavigateRequest,
  type BrowserObserveRequest,
  type BrowserPageState,
  type BrowserRuntimeState,
  type BrowserScreenshot,
  type BrowserTarget,
} from '@deepseek-ai/dsh-browser-runtime'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { applyBrowserWorkspaceProjection, EMPTY_BROWSER_WORKSPACE, foldBrowserWorkspace } from './fold.ts'
import type {
  BrowserWorkspaceCreateRemoteRequest,
  BrowserWorkspaceInstanceRecord,
  BrowserWorkspaceProjection,
  BrowserWorkspaceRecord,
  BrowserWorkspaceTabRecord,
} from './types.ts'

export type * from './types.ts'
export { applyBrowserWorkspaceProjection, EMPTY_BROWSER_WORKSPACE, foldBrowserWorkspace } from './fold.ts'
export { listBrowserWorkspacePages } from './pages.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserWorkspace: BrowserWorkspaceBinder
  }
}

const workspaceProjectionSchema = zod.object({
  workspaces: zod.array(zod.object({
    workspaceId: zod.string().min(1),
    profileId: zod.string().min(1),
    browsers: zod.array(zod.object({
      browserId: zod.string().min(1),
      tabs: zod.array(zod.object({
        tabId: zod.string().min(1),
        revision: zod.number().int().nonnegative(),
      })),
      activeTabId: zod.string().min(1).nullable(),
    })),
    activeBrowserId: zod.string().min(1).nullable(),
  })),
  activeWorkspaceId: zod.string().min(1).nullable(),
}) as unknown as ZodType<BrowserWorkspaceProjection>

/** Request that names the owning Session for one Browser Runtime operation. */
export interface BrowserWorkspaceSessionRequest {
  readonly session: Session
}

/** Create request bound to one Session. */
export type BrowserWorkspaceCreateRequest = BrowserCreateRequest & BrowserWorkspaceSessionRequest
/** Mutation request bound to one Session. */
export type BrowserWorkspaceMutationRequest = BrowserMutationRequest & BrowserWorkspaceSessionRequest
/** Navigate request bound to one Session. */
export type BrowserWorkspaceNavigateRequest = BrowserNavigateRequest & BrowserWorkspaceSessionRequest
/** Synthetic input request bound to one Session. */
export type BrowserWorkspaceInputRequest = BrowserInputRequest & BrowserWorkspaceSessionRequest
/** Observe request bound to one Session. */
export type BrowserWorkspaceObserveRequest = BrowserObserveRequest & BrowserWorkspaceSessionRequest

/** Reconstruct one Runtime target from its projected ownership records. */
function targetOf(
  workspace: BrowserWorkspaceRecord,
  browser: BrowserWorkspaceInstanceRecord,
  tab: BrowserWorkspaceTabRecord,
): BrowserTarget {
  return {
    profileId: workspace.profileId,
    workspaceId: workspace.workspaceId,
    browserId: browser.browserId,
    tabId: tab.tabId,
  }
}

/**
 * Bind Browser Runtime identities to one Session log and project instance and
 * tab ownership from durable Session facts.
 */
export class BrowserWorkspaceBinder extends TypertRemoteService {
  static inject = ['browserRuntime', 'sessions']
  private createTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'browserWorkspace')
    ctx.on('session/disposed', (session) => { void this.cleanup(session) }, { global: true })
    ctx.on('browser/runtime-state', (state) => { this.syncRuntimeState(state) }, { global: true })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'browserWorkspace', BrowserWorkspaceProjection>({
        key: 'browserWorkspace',
        schema: workspaceProjectionSchema,
        init: () => EMPTY_BROWSER_WORKSPACE,
        apply: applyBrowserWorkspaceProjection,
        view: state => state,
        stateVersion: 3,
      })
    })
  }

  /**
   * Read the last logged Workspace for one Session.
   * @param session - Owning Session.
   * @returns the last logged snapshot, or the empty Workspace.
   */
  snapshot(session: Session): BrowserWorkspaceProjection {
    return foldBrowserWorkspace(session.events)
  }

  /**
   * Observe one Session-owned tab named on the wire.
   * @param sessionId - Owning Session identity.
   * @param target - Complete tab identity.
   * @returns the current open, unavailable, or closed state. A closed result
   *   forgets the listing row.
   */
  @Remote('observe')
  remoteObserve(sessionId: SessionId, target: BrowserTarget): Promise<BrowserRuntimeState> {
    return this.observe({ session: this.requireSession(sessionId), target })
  }

  /**
   * Capture one Session-owned tab named on the wire.
   * @param sessionId - Owning Session identity.
   * @param target - Complete tab identity.
   * @returns screenshot bytes and depicted page facts.
   */
  @Remote('screenshot')
  remoteScreenshot(sessionId: SessionId, target: BrowserTarget): Promise<BrowserScreenshot> {
    return this.screenshot({ session: this.requireSession(sessionId), target })
  }

  /**
   * Focus one Session-owned tab named on the wire.
   * @param sessionId - Owning Session identity.
   * @param target - Complete tab identity.
   * @param expectedRevision - Latest revision returned by a browser operation.
   * @returns the committed focused page.
   */
  @Remote('focus')
  remoteFocus(sessionId: SessionId, target: BrowserTarget, expectedRevision: number): Promise<BrowserPageState> {
    return this.focus({ session: this.requireSession(sessionId), target, expectedRevision })
  }

  /**
   * Navigate one Session-owned tab named on the wire.
   * @param sessionId - Owning Session identity.
   * @param target - Complete tab identity.
   * @param expectedRevision - Latest revision returned by a browser operation.
   * @param url - URL to open.
   * @returns the committed open page.
   */
  @Remote('navigate')
  remoteNavigate(
    sessionId: SessionId,
    target: BrowserTarget,
    expectedRevision: number,
    url: string,
  ): Promise<BrowserPageState> {
    return this.navigate({ session: this.requireSession(sessionId), target, expectedRevision, url })
  }

  /**
   * Send one Agent-specified synthetic input to a Session-owned tab named on the wire.
   * @param sessionId - Owning Session identity.
   * @param target - Complete tab identity.
   * @param expectedRevision - Latest revision returned by a browser operation.
   * @param input - URL or text supplied by the Agent.
   * @returns the committed open page.
   */
  @Remote('input')
  remoteInput(
    sessionId: SessionId,
    target: BrowserTarget,
    expectedRevision: number,
    input: { readonly url?: string; readonly text?: string },
  ): Promise<BrowserPageState> {
    const base = {
      session: this.requireSession(sessionId),
      target,
      expectedRevision,
    }
    if (input.url !== undefined) {
      return this.input({
        ...base,
        url: input.url,
        ...input.text === undefined ? {} : { text: input.text },
      })
    }
    if (input.text !== undefined) return this.input({ ...base, text: input.text })
    throw new BrowserRuntimeError('browser input requires url or text', 'BROWSER_PROTOCOL')
  }

  /**
   * Close one Session-owned tab named on the wire.
   * @param sessionId - Owning Session identity.
   * @param target - Complete tab identity.
   * @param expectedRevision - Latest revision returned by a browser operation.
   * @returns the terminal close receipt.
   */
  @Remote('close')
  remoteClose(sessionId: SessionId, target: BrowserTarget, expectedRevision: number): Promise<BrowserClosedState> {
    return this.close({ session: this.requireSession(sessionId), target, expectedRevision })
  }

  /**
   * Create one tab in the Session named on the wire.
   * @param sessionId - Owning Session identity.
   * @param request - Wire create identity and optional attach.
   * @returns the committed open page.
   */
  @Remote('create')
  remoteCreate(sessionId: SessionId, request: BrowserWorkspaceCreateRemoteRequest): Promise<BrowserPageState> {
    return this.create({
      session: this.requireSession(sessionId),
      ...request.profile === 'persistent'
        ? { profile: 'persistent', name: BrowserProfileName(request.name) }
        : { profile: request.profile },
      ...request.attach === undefined ? {} : { attach: request.attach },
    })
  }

  /**
   * Create one tab in the Session's Browser Workspace.
   * @param request - Session-bound create request.
   * @returns the committed open page.
   */
  async create(request: BrowserWorkspaceCreateRequest): Promise<BrowserPageState> {
    const result = this.createTail.then(() => this.createOwned(request))
    this.createTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Create after all earlier Binder creates have committed or failed. */
  private async createOwned(request: BrowserWorkspaceCreateRequest): Promise<BrowserPageState> {
    this.assertCreateAttach(request.session, request.attach)
    const attach = request.attach ?? await this.findMatchingBrowser(request)
    const created = await this.ctx.browserRuntime.create({
      ...request,
      ...attach === undefined ? {} : { attach },
    })
    this.adopt(request.session, created.target, created.revision)
    return created
  }

  /**
   * Navigate one Session-owned tab.
   * @param request - Session-bound navigate request.
   * @returns the committed open page.
   */
  async navigate(request: BrowserWorkspaceNavigateRequest): Promise<BrowserPageState> {
    this.assertOwned(request.session, request.target)
    const navigated = await this.ctx.browserRuntime.navigate(request)
    this.recordRevision(request.session, navigated.target, navigated.revision)
    return navigated
  }

  /**
   * Observe one Session-owned tab.
   * @param request - Session-bound observe request.
   * @returns the current open, unavailable, or closed state. A closed result
   *   forgets the listing row.
   */
  async observe(request: BrowserWorkspaceObserveRequest): Promise<BrowserRuntimeState> {
    this.assertOwned(request.session, request.target)
    const state = await this.ctx.browserRuntime.observe(request)
    if (state.status === 'closed') {
      this.forget(request.session, state.target)
    } else {
      this.recordRevision(request.session, state.target, state.revision)
    }
    return state
  }

  /**
   * Capture one Session-owned tab.
   * @param request - Session-bound observe request.
   * @returns screenshot bytes and depicted page facts.
   */
  async screenshot(request: BrowserWorkspaceObserveRequest): Promise<BrowserScreenshot> {
    this.assertOwned(request.session, request.target)
    return this.ctx.browserRuntime.screenshot(request)
  }

  /**
   * Focus one Session-owned tab and record it as the Session's active tab.
   * @param request - Session-bound mutation request.
   * @returns the committed focused page.
   */
  async focus(request: BrowserWorkspaceMutationRequest): Promise<BrowserPageState> {
    this.assertOwned(request.session, request.target)
    const focused = await this.ctx.browserRuntime.focus(request)
    this.recordRevision(request.session, focused.target, focused.revision)
    this.activate(request.session, focused.target)
    return focused
  }

  /**
   * Send one Agent-specified synthetic input to a Session-owned tab.
   * @param request - Session-bound input request.
   * @returns the committed open page.
   */
  async input(request: BrowserWorkspaceInputRequest): Promise<BrowserPageState> {
    this.assertOwned(request.session, request.target)
    const inputted = await this.ctx.browserRuntime.input(request)
    this.recordRevision(request.session, inputted.target, inputted.revision)
    return inputted
  }

  /**
   * Close one Session-owned tab and drop it from the Session Workspace.
   * @param request - Session-bound mutation request.
   * @returns the terminal close receipt.
   */
  async close(request: BrowserWorkspaceMutationRequest): Promise<BrowserClosedState> {
    this.assertOwned(request.session, request.target)
    const closed = await this.ctx.browserRuntime.close(request)
    this.forget(request.session, closed.target)
    return closed
  }

  /**
   * Close every live tab still owned by one Session.
   * @param session - Session whose leftover Runtime tabs must be closed.
   */
  async cleanup(session: Session): Promise<void> {
    const snapshot = this.snapshot(session)
    for (const workspace of snapshot.workspaces) {
      for (const browser of workspace.browsers) {
        for (const tab of browser.tabs) {
          const target = targetOf(workspace, browser, tab)
          try {
            const state = await this.ctx.browserRuntime.observe({ target })
            if (state.status !== 'closed') {
              await this.ctx.browserRuntime.close({ target, expectedRevision: state.revision })
            }
          } catch (error) {
            this.ctx.logger.warn('browser-workspace: Session cleanup failed for one tab')
            this.ctx.logger.warn(error)
          }
          this.forget(session, target)
        }
      }
    }
  }

  /** Reject attach that names another Session's hierarchy or an unowned one. */
  private assertCreateAttach(session: Session, attach: BrowserCreateRequest['attach']): void {
    if (attach === undefined) return
    const owner = this.ownerOfAttach(attach)
    if (owner !== undefined && owner.id !== session.id) {
      throw new BrowserRuntimeError('cross-Session page transfer is not supported', 'BROWSER_TRANSFER_UNSUPPORTED')
    }
    if (!ownsAttach(this.snapshot(session), attach)) {
      throw new BrowserRuntimeError('browser attach target is not owned by this Session', 'BROWSER_SESSION_MISMATCH')
    }
  }

  /** Find the live Session that already owns one attach hierarchy, if any. */
  private ownerOfAttach(attach: NonNullable<BrowserCreateRequest['attach']>): Session | undefined {
    return this.ctx.sessions.list().find(session => ownsAttach(this.snapshot(session), attach))
  }

  /**
   * Reuse one open browser instance on the requested retained Profile.
   * A logged target missing from the current Runtime is forgotten before matching continues.
   */
  private async findMatchingBrowser(
    request: BrowserWorkspaceCreateRequest,
  ): Promise<BrowserCreateAttach | undefined> {
    if (request.profile === 'temporary') return undefined
    const snapshot = this.snapshot(request.session)
    for (const workspace of snapshot.workspaces) {
      for (const browser of workspace.browsers) {
        for (const tab of browser.tabs) {
          const target = targetOf(workspace, browser, tab)
          let state: BrowserRuntimeState
          try {
            state = await this.ctx.browserRuntime.observe({
              target,
              ...request.signal === undefined ? {} : { signal: request.signal },
            })
          } catch (error) {
            if (!(error instanceof BrowserRuntimeError) || error.code !== 'BROWSER_NOT_FOUND') throw error
            this.forget(request.session, target)
            continue
          }
          if (state.status === 'closed') {
            this.forget(request.session, state.target)
            continue
          }
          this.recordRevision(request.session, state.target, state.revision)
          if (state.status === 'open' && matchesCreateProfile(request, state)) {
            return {
              kind: 'browser',
              workspaceId: workspace.workspaceId,
              browserId: browser.browserId,
            }
          }
        }
      }
    }
    return undefined
  }

  /** Reject a target that another Session owns or that this Session never adopted. */
  private assertOwned(session: Session, target: BrowserTarget): void {
    for (const other of this.ctx.sessions.list()) {
      if (other.id === session.id) continue
      if (ownsTarget(this.snapshot(other), target)) {
        throw new BrowserRuntimeError('cross-Session page transfer is not supported', 'BROWSER_TRANSFER_UNSUPPORTED')
      }
    }
    if (!ownsTarget(this.snapshot(session), target)) {
      throw new BrowserRuntimeError('browser target is not owned by this Session', 'BROWSER_SESSION_MISMATCH')
    }
  }

  /** Resolve the live Session named on the wire, or reject an unknown identity. */
  private requireSession(sessionId: SessionId): Session {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new BrowserRuntimeError('browser target is not owned by this Session', 'BROWSER_SESSION_MISMATCH')
    }
    return session
  }

  /** Record a newly created tab on the owning Session. */
  private adopt(
    session: Session,
    target: BrowserTarget,
    revision: number,
  ): void {
    const current = this.snapshot(session)
    this.commit(session, adoptTarget(current, target, revision))
  }

  /**
   * Write listing facts for an owned, unclosed Runtime commit, including
   * revision bumps that never entered a Binder verb.
   * @param state - Committed Runtime state after any Provider operation.
   */
  private syncRuntimeState(state: BrowserRuntimeState): void {
    if (state.status === 'closed') return
    const session = this.ctx.sessions.list().find(item => ownsTarget(this.snapshot(item), state.target))
    if (session === undefined) return
    this.recordRevision(session, state.target, state.revision)
  }

  /** Persist the current revision for one already-owned tab. */
  private recordRevision(
    session: Session,
    target: BrowserTarget,
    revision: number,
  ): void {
    const current = this.snapshot(session)
    this.commit(session, recordTabRevision(current, target, revision))
  }

  /** Record the focused tab as the Session's active tab. */
  private activate(session: Session, target: BrowserTarget): void {
    const current = this.snapshot(session)
    this.commit(session, activateTarget(current, target))
  }

  /** Drop a closed tab from the Session Workspace. */
  private forget(session: Session, target: BrowserTarget): void {
    const current = this.snapshot(session)
    this.commit(session, forgetTarget(current, target))
  }

  /** Append one whole-value Workspace snapshot when it differs. */
  private commit(session: Session, next: BrowserWorkspaceProjection): BrowserWorkspaceProjection {
    const current = this.snapshot(session)
    if (sameSnapshot(current, next)) return current
    const committed = freezeSnapshot(next)
    session.append('browser/workspace', committed)
    return committed
  }
}

/** Whether one snapshot already names the complete target. */
function ownsTarget(snapshot: BrowserWorkspaceProjection, target: BrowserTarget): boolean {
  const workspace = snapshot.workspaces.find(item => item.workspaceId === target.workspaceId)
  if (workspace === undefined || workspace.profileId !== target.profileId) return false
  const browser = workspace.browsers.find(item => item.browserId === target.browserId)
  return browser?.tabs.some(tab => tab.tabId === target.tabId) === true
}

/** Whether one snapshot already owns the Workspace or instance named by attach. */
function ownsAttach(snapshot: BrowserWorkspaceProjection, attach: BrowserCreateAttach): boolean {
  const workspace = snapshot.workspaces.find(item => item.workspaceId === attach.workspaceId)
  if (workspace === undefined) return false
  return attach.kind === 'workspace' || workspace.browsers.some(browser => browser.browserId === attach.browserId)
}

/** Add one target to the Session snapshot, creating Workspace and instance rows as needed. */
function adoptTarget(
  snapshot: BrowserWorkspaceProjection,
  target: BrowserTarget,
  revision: number,
): BrowserWorkspaceProjection {
  const workspaces = snapshot.workspaces.map(workspace => ({
    ...workspace,
    browsers: workspace.browsers.map(browser => ({
      ...browser,
      tabs: [...browser.tabs],
    })),
  }))
  let workspace = workspaces.find(item => item.workspaceId === target.workspaceId)
  if (workspace === undefined) {
    workspace = {
      workspaceId: target.workspaceId,
      profileId: target.profileId,
      browsers: [],
      activeBrowserId: target.browserId,
    }
    workspaces.push(workspace)
  }
  let browser = workspace.browsers.find(item => item.browserId === target.browserId)
  if (browser === undefined) {
    browser = { browserId: target.browserId, tabs: [], activeTabId: target.tabId }
    workspace.browsers.push(browser)
  }
  browser.tabs.push({ tabId: target.tabId, revision })
  workspace.activeBrowserId = target.browserId
  browser.activeTabId = target.tabId
  return {
    ...snapshot,
    workspaces,
    activeWorkspaceId: target.workspaceId,
  }
}

/** Persist the current revision for one already-owned tab. */
function recordTabRevision(
  snapshot: BrowserWorkspaceProjection,
  target: BrowserTarget,
  revision: number,
): BrowserWorkspaceProjection {
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => {
      if (workspace.workspaceId !== target.workspaceId) return workspace
      return {
        ...workspace,
        browsers: workspace.browsers.map((browser) => {
          if (browser.browserId !== target.browserId) return browser
          return {
            ...browser,
            tabs: browser.tabs.map(tab => (
              tab.tabId === target.tabId ? { ...tab, revision } : tab
            )),
          }
        }),
      }
    }),
  }
}

/** Mark one already-owned target as the Session's active tab. */
function activateTarget(snapshot: BrowserWorkspaceProjection, target: BrowserTarget): BrowserWorkspaceProjection {
  return {
    ...snapshot,
    activeWorkspaceId: target.workspaceId,
    workspaces: snapshot.workspaces.map((workspace) => {
      if (workspace.workspaceId !== target.workspaceId) return workspace
      return {
        ...workspace,
        activeBrowserId: target.browserId,
        browsers: workspace.browsers.map((browser) => {
          if (browser.browserId !== target.browserId) return browser
          return { ...browser, activeTabId: target.tabId }
        }),
      }
    }),
  }
}

/** Remove one closed target and collapse empty instance and Workspace rows. */
function forgetTarget(snapshot: BrowserWorkspaceProjection, target: BrowserTarget): BrowserWorkspaceProjection {
  const workspaces = snapshot.workspaces.flatMap((workspace): BrowserWorkspaceRecord[] => {
    if (workspace.workspaceId !== target.workspaceId) return [workspace]
    const browsers = workspace.browsers.flatMap((browser): BrowserWorkspaceInstanceRecord[] => {
      if (browser.browserId !== target.browserId) return [browser]
      const tabs = browser.tabs.filter(tab => tab.tabId !== target.tabId)
      if (tabs.length === 0) return []
      const remainingTab = tabs.at(-1)
      return [{
        ...browser,
        tabs,
        activeTabId: browser.activeTabId === target.tabId && remainingTab !== undefined
          ? remainingTab.tabId
          : browser.activeTabId,
      }]
    })
    if (browsers.length === 0) return []
    const remainingBrowser = browsers.at(-1)
    return [{
      ...workspace,
      browsers,
      activeBrowserId: browsers.some(browser => browser.browserId === workspace.activeBrowserId)
        || remainingBrowser === undefined
        ? workspace.activeBrowserId
        : remainingBrowser.browserId,
    }]
  })
  const activeWorkspaceId = snapshot.activeWorkspaceId === target.workspaceId
    && !workspaces.some(workspace => workspace.workspaceId === target.workspaceId)
    ? (workspaces.at(-1)?.workspaceId ?? null)
    : snapshot.activeWorkspaceId
  return { ...snapshot, workspaces, activeWorkspaceId }
}

/** Compare two snapshots without depending on object identity. */
function sameSnapshot(left: BrowserWorkspaceProjection, right: BrowserWorkspaceProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Freeze one snapshot so later mutation cannot change the logged value. */
function freezeSnapshot(snapshot: BrowserWorkspaceProjection): BrowserWorkspaceProjection {
  return Object.freeze({
    activeWorkspaceId: snapshot.activeWorkspaceId,
    workspaces: Object.freeze(snapshot.workspaces.map(workspace => Object.freeze({
      workspaceId: workspace.workspaceId,
      profileId: workspace.profileId,
      activeBrowserId: workspace.activeBrowserId,
      browsers: Object.freeze(workspace.browsers.map(browser => Object.freeze({
        browserId: browser.browserId,
        activeTabId: browser.activeTabId,
        tabs: Object.freeze(browser.tabs.map(tab => Object.freeze({
          tabId: tab.tabId,
          revision: tab.revision,
        } satisfies BrowserWorkspaceTabRecord))),
      }))),
    }))),
  })
}

/** Whether one open page belongs to the retained Profile requested by create. */
function matchesCreateProfile(
  request: Exclude<BrowserCreateRequest, { readonly profile: 'temporary' }>,
  state: BrowserPageState,
): boolean {
  if (request.profile === 'shared') return state.chrome.kind === 'shared'
  return state.chrome.kind === 'persistent' && state.chrome.name === request.name
}

export default BrowserWorkspaceBinder
