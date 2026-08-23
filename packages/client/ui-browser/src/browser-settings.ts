/**
 * Durable Browser Profile defaults stored in the Host user-settings document.
 */

import z from '@deepseek-ai/schemastery'
import type { BrowserWorkspaceCreateRemoteRequest } from '@deepseek-ai/dsh-browser-workspace/client'

/** Settings namespace owned by the Browser Dock plugin. */
export const BROWSER_SETTINGS_NAMESPACE = 'ui-browser'

/** Built-in create identities a new tab or `browser_create` omit-profile uses. */
export const BROWSER_PROFILE_KINDS = ['shared', 'temporary', 'persistent'] as const

/** Create identity persisted by the Browser settings section. */
export type BrowserProfileKindSetting = typeof BROWSER_PROFILE_KINDS[number]

/**
 * Stable partition key for a named persistent Profile. Rejects `shared`,
 * `tmp`, and `tmp-*` so those reserved identities cannot enter the roster.
 */
export const BROWSER_PROFILE_NAME = /^(?!tmp(?:-|$)|shared$)[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** Default create identity when the user-settings document has no override. */
export const DEFAULT_BROWSER_PROFILE_KIND: BrowserProfileKindSetting = 'shared'

/** Durable Browser Profile section. */
export interface BrowserSettings {
  /** Identity used when the model omits `browser_create.profile`. */
  defaultKind: BrowserProfileKindSetting
  /** Persistent Profile name used when {@link defaultKind} is `persistent`. */
  defaultPersistentName: string
  /** Named persistent Profiles the human can pick as the default. */
  namedProfiles: string[]
}

/** Empty roster and shared default matching today's omit-profile behavior. */
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  defaultKind: DEFAULT_BROWSER_PROFILE_KIND,
  defaultPersistentName: '',
  namedProfiles: [],
}

/**
 * Whether one string can be a named persistent Browser Profile.
 * @param value - Candidate name from settings or the add-profile field.
 * @returns whether the value is a stable partition key.
 */
export function isBrowserProfileName(value: string): boolean {
  return BROWSER_PROFILE_NAME.test(value)
}

/**
 * Wire create identity from the durable Browser settings section.
 * An incomplete persistent default falls back to shared.
 * @param settings - Resolved `ui-browser` section.
 * @returns the Remote create payload.
 */
export function browserCreateRequestFromSettings(
  settings: BrowserSettings,
): BrowserWorkspaceCreateRemoteRequest {
  if (settings.defaultKind === 'temporary') return { profile: 'temporary' }
  if (settings.defaultKind === 'persistent') {
    const named = settings.defaultPersistentName.trim()
    const fallback = settings.namedProfiles.find(entry => entry.trim().length > 0)?.trim()
    const name = named.length > 0 ? named : fallback
    if (name === undefined || name.length === 0) return { profile: 'shared' }
    return { profile: 'persistent', name }
  }
  return { profile: 'shared' }
}

/** Durable schema; also the wire envelope the browser scope validates against. */
export const BrowserSettingsSchema: z<BrowserSettings> = z.object({
  defaultKind: z.union([...BROWSER_PROFILE_KINDS]).default(DEFAULT_BROWSER_PROFILE_KIND),
  defaultPersistentName: z.string().default(''),
  namedProfiles: z.array(z.string()).default([]),
})
