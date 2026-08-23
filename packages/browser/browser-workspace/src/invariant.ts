/** Package-owned durable Browser Workspace invariants. @module @deepseek-ai/dsh-browser-workspace/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { BrowserWorkspaceProjection } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-browser-workspace'

/** Cordis companion plugin name. */
export const name = 'browser-workspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one whole Workspace snapshot before it reaches the durable log. */
function validateSnapshot(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null) fail('browser/workspace must be an object')
  const snapshot = value as BrowserWorkspaceProjection
  if (!Array.isArray(snapshot.workspaces)) fail('browser/workspace workspaces must be an array')
  const workspaceIds = new Set<string>()
  for (const rawWorkspace of snapshot.workspaces) {
    if (typeof rawWorkspace !== 'object' || rawWorkspace === null) fail('browser/workspace workspaces must be objects')
    const workspace = rawWorkspace as Record<string, unknown>
    if (typeof workspace.workspaceId !== 'string' || workspace.workspaceId.length === 0) {
      fail('browser/workspace workspaceId must be a non-empty string')
    }
    if (workspaceIds.has(workspace.workspaceId)) fail('browser/workspace repeats a workspaceId')
    workspaceIds.add(workspace.workspaceId)
    if (typeof workspace.profileId !== 'string' || workspace.profileId.length === 0) {
      fail('browser/workspace profileId must be a non-empty string')
    }
    if (!Array.isArray(workspace.browsers)) fail('browser/workspace browsers must be an array')
    const browserIds = new Set<string>()
    for (const rawBrowser of workspace.browsers) {
      if (typeof rawBrowser !== 'object' || rawBrowser === null) fail('browser/workspace browsers must be objects')
      const browser = rawBrowser as Record<string, unknown>
      if (typeof browser.browserId !== 'string' || browser.browserId.length === 0) {
        fail('browser/workspace browserId must be a non-empty string')
      }
      if (browserIds.has(browser.browserId)) fail('browser/workspace repeats a browserId')
      browserIds.add(browser.browserId)
      if (!Array.isArray(browser.tabs)) fail('browser/workspace tabs must be an array')
      const tabIds = new Set<string>()
      for (const rawTab of browser.tabs) {
        if (typeof rawTab !== 'object' || rawTab === null) fail('browser/workspace tabs must be objects')
        const tab = rawTab as Record<string, unknown>
        if (typeof tab.tabId !== 'string' || tab.tabId.length === 0) {
          fail('browser/workspace tabId must be a non-empty string')
        }
        if (typeof tab.revision !== 'number' || !Number.isSafeInteger(tab.revision) || tab.revision < 0) {
          fail('browser/workspace revision must be a non-negative safe integer')
        }
        if (tabIds.has(tab.tabId)) fail('browser/workspace repeats a tabId')
        tabIds.add(tab.tabId)
      }
      if (typeof browser.activeTabId === 'string' && !tabIds.has(browser.activeTabId)) {
        fail('browser/workspace activeTabId must name an owned tab')
      }
    }
    if (typeof workspace.activeBrowserId === 'string' && !browserIds.has(workspace.activeBrowserId)) {
      fail('browser/workspace activeBrowserId must name an owned browser')
    }
  }
  if (snapshot.activeWorkspaceId !== null && !workspaceIds.has(snapshot.activeWorkspaceId)) {
    fail('browser/workspace activeWorkspaceId must name an owned Workspace')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'browser/workspace') validateSnapshot(event.data, fail)
}

/** Install validation for loaded and newly appended Workspace snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the Browser Workspace invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
