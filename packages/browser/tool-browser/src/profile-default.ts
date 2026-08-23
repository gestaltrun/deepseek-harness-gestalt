/**
 * Omit-profile `browser_create` identity from the `ui-browser` settings section.
 */

/** Model-facing `browser_create` profile identities. */
type BrowserCreateProfile = 'temporary' | 'persistent' | 'shared'

/** Resolved omit-profile identity, including a persistent name when one exists. */
export interface BrowserCreateDefault {
  /** Create identity. */
  kind: BrowserCreateProfile
  /** Persistent Profile name when {@link kind} is `persistent`. */
  name?: string
}

/**
 * Read the Host `ui-browser` section into an omit-profile create identity.
 * An unknown or incomplete section keeps today's shared default.
 * @param section - Resolved settings value, or `undefined` when settings is absent.
 * @returns the identity `browser_create` uses when the model omits `profile`.
 */
export function defaultBrowserCreateFromSettings(section: unknown): BrowserCreateDefault {
  if (section === null || typeof section !== 'object') return { kind: 'shared' }
  const record = section as Record<string, unknown>
  if (record.defaultKind === 'temporary') return { kind: 'temporary' }
  if (record.defaultKind === 'persistent') {
    const named = typeof record.defaultPersistentName === 'string' ? record.defaultPersistentName.trim() : ''
    const roster = Array.isArray(record.namedProfiles) ? record.namedProfiles : []
    const fallback = roster.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    const name = named.length > 0 ? named : fallback?.trim()
    if (name === undefined || name.length === 0) return { kind: 'shared' }
    return { kind: 'persistent', name }
  }
  return { kind: 'shared' }
}
