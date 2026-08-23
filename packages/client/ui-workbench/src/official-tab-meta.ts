/**
 * Sidebar tab.meta payload that binds one snapshot browser tab to one
 * official Session-owned Browser Workspace page.
 */

import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'

/** JSON form of a target stored in sidebar tab metadata. */
export type StoredBrowserTarget = {
  readonly profileId: string
  readonly workspaceId: string
  readonly browserId: string
  readonly tabId: string
}

/** Official page identity stored on a snapshot browser tab. */
export interface OfficialBrowserTabMeta {
  /** Complete Runtime tab identity. */
  readonly official: StoredBrowserTarget
  /** Runtime-observed Profile identity used to decide whether another tab may attach. */
  readonly profile?: OfficialBrowserProfile
}

/** Profile identity relevant to Workbench browser-instance reuse. */
export type OfficialBrowserProfile =
  | { readonly kind: 'temporary' }
  | { readonly kind: 'shared' }
  | { readonly kind: 'persistent'; readonly name: string }

/**
 * Stable key for one official page identity.
 * @param target - Complete tab identity.
 * @returns a slash-joined identity key.
 */
export function officialTargetKey(target: StoredBrowserTarget): string {
  return `${target.profileId}/${target.workspaceId}/${target.browserId}/${target.tabId}`
}

/**
 * Read an official page identity from snapshot tab meta.
 * @param meta - Persisted tab meta.
 * @returns the identity, or undefined when the tab is not yet bound.
 */
export function officialTargetOf(meta: unknown): BrowserTarget | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const official = (meta as { official?: unknown }).official
  if (official === null || typeof official !== 'object') return undefined
  const record = official as Record<string, unknown>
  const profileId = record.profileId
  const workspaceId = record.workspaceId
  const browserId = record.browserId
  const tabId = record.tabId
  if (
    typeof profileId !== 'string' || profileId.length === 0
    || typeof workspaceId !== 'string' || workspaceId.length === 0
    || typeof browserId !== 'string' || browserId.length === 0
    || typeof tabId !== 'string' || tabId.length === 0
  ) {
    return undefined
  }
  return {
    profileId: profileId as BrowserTarget['profileId'],
    workspaceId: workspaceId as BrowserTarget['workspaceId'],
    browserId: browserId as BrowserTarget['browserId'],
    tabId: tabId as BrowserTarget['tabId'],
  }
}

/**
 * Read the Runtime-observed Profile identity from snapshot tab meta.
 * @param meta - Persisted tab meta.
 * @returns the Profile identity, or undefined before the page has been observed.
 */
export function officialProfileOf(meta: unknown): OfficialBrowserProfile | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const profile = (meta as { profile?: unknown }).profile
  if (profile === null || typeof profile !== 'object') return undefined
  const record = profile as Record<string, unknown>
  if (record.kind === 'temporary' || record.kind === 'shared') return { kind: record.kind }
  if (record.kind !== 'persistent' || typeof record.name !== 'string' || record.name.length === 0) {
    return undefined
  }
  return { kind: 'persistent', name: record.name }
}

/**
 * Reduce Runtime page chrome to the Profile identity persisted by the Workbench.
 * @param chrome - Runtime-observed Profile chrome.
 * @returns a reusable Profile identity, or undefined for malformed persistent chrome.
 */
export function officialProfileFromChrome(chrome: {
  readonly kind: 'temporary' | 'shared' | 'persistent'
  readonly name?: string
} | undefined): OfficialBrowserProfile | undefined {
  if (chrome?.kind === 'temporary' || chrome?.kind === 'shared') return { kind: chrome.kind }
  if (chrome?.kind !== 'persistent' || chrome.name === undefined || chrome.name.length === 0) return undefined
  return { kind: 'persistent', name: chrome.name }
}

/**
 * Build tab meta for one official page.
 * @param target - Complete tab identity.
 * @param profile - Runtime-observed Profile identity, when known.
 * @returns JSON-serializable meta.
 */
export function officialTabMeta(
  target: StoredBrowserTarget,
  profile?: OfficialBrowserProfile,
): OfficialBrowserTabMeta {
  return {
    official: { ...target },
    ...(profile === undefined ? {} : { profile: { ...profile } }),
  }
}
