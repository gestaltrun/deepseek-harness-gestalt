/** Browser Profile settings names and schema defaults. */
import { describe, expect, it } from 'vitest'
import {
  BROWSER_SETTINGS_NAMESPACE,
  BrowserSettingsSchema,
  DEFAULT_BROWSER_SETTINGS,
  browserCreateRequestFromSettings,
  isBrowserProfileName,
} from '../src/browser-settings.ts'

describe('isBrowserProfileName', () => {
  it('accepts a stable partition key and rejects reserved identities', () => {
    expect(isBrowserProfileName('work')).toBe(true)
    expect(isBrowserProfileName('Work_1.team')).toBe(true)
    expect(isBrowserProfileName('shared')).toBe(false)
    expect(isBrowserProfileName('tmp')).toBe(false)
    expect(isBrowserProfileName('tmp-scratch')).toBe(false)
    expect(isBrowserProfileName('')).toBe(false)
    expect(isBrowserProfileName('-lead')).toBe(false)
  })
})

describe('BrowserSettingsSchema', () => {
  it('defaults to the shared omit-profile identity and an empty roster', () => {
    expect(BROWSER_SETTINGS_NAMESPACE).toBe('ui-browser')
    expect(BrowserSettingsSchema({} as typeof DEFAULT_BROWSER_SETTINGS)).toEqual(DEFAULT_BROWSER_SETTINGS)
  })
})

describe('browserCreateRequestFromSettings', () => {
  it('maps each default kind and falls back to shared without a persistent name', () => {
    expect(browserCreateRequestFromSettings({
      ...DEFAULT_BROWSER_SETTINGS,
      defaultKind: 'temporary',
    })).toEqual({ profile: 'temporary' })
    expect(browserCreateRequestFromSettings({
      ...DEFAULT_BROWSER_SETTINGS,
      defaultKind: 'persistent',
      defaultPersistentName: 'work',
    })).toEqual({ profile: 'persistent', name: 'work' })
    expect(browserCreateRequestFromSettings({
      ...DEFAULT_BROWSER_SETTINGS,
      defaultKind: 'persistent',
      namedProfiles: ['  lab  '],
    })).toEqual({ profile: 'persistent', name: 'lab' })
    expect(browserCreateRequestFromSettings({
      ...DEFAULT_BROWSER_SETTINGS,
      defaultKind: 'persistent',
    })).toEqual({ profile: 'shared' })
    expect(browserCreateRequestFromSettings(DEFAULT_BROWSER_SETTINGS)).toEqual({ profile: 'shared' })
  })
})
