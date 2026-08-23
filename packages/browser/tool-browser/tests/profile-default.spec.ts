/** Omit-profile identity from the ui-browser settings section. */
import { describe, expect, it } from 'vitest'
import { defaultBrowserCreateFromSettings } from '../src/profile-default.ts'

describe('defaultBrowserCreateFromSettings', () => {
  it('keeps the shared identity when settings are absent or unknown', () => {
    expect(defaultBrowserCreateFromSettings(undefined)).toEqual({ kind: 'shared' })
    expect(defaultBrowserCreateFromSettings(null)).toEqual({ kind: 'shared' })
    expect(defaultBrowserCreateFromSettings({ defaultKind: 'shared' })).toEqual({ kind: 'shared' })
    expect(defaultBrowserCreateFromSettings({ defaultKind: 'other' })).toEqual({ kind: 'shared' })
  })

  it('returns temporary and persistent defaults, falling back to shared without a name', () => {
    expect(defaultBrowserCreateFromSettings({ defaultKind: 'temporary' })).toEqual({ kind: 'temporary' })
    expect(defaultBrowserCreateFromSettings({
      defaultKind: 'persistent',
      defaultPersistentName: 'work',
    })).toEqual({ kind: 'persistent', name: 'work' })
    expect(defaultBrowserCreateFromSettings({
      defaultKind: 'persistent',
      namedProfiles: ['lab'],
    })).toEqual({ kind: 'persistent', name: 'lab' })
    expect(defaultBrowserCreateFromSettings({ defaultKind: 'persistent' })).toEqual({ kind: 'shared' })
    expect(defaultBrowserCreateFromSettings({
      defaultKind: 'persistent',
      defaultPersistentName: '  ',
      namedProfiles: ['  ', 1],
    })).toEqual({ kind: 'shared' })
  })
})
