import { describe, expect, it } from 'vitest'
import {
  officialProfileFromChrome, officialProfileOf, officialTabMeta, officialTargetKey, officialTargetOf,
} from '../src/official-tab-meta.ts'

const TARGET = {
  profileId: 'p',
  workspaceId: 'w',
  browserId: 'b',
  tabId: 't',
}

describe('official tab meta', () => {
  it('round-trips a complete identity and rejects incomplete meta', () => {
    expect(officialTargetKey(TARGET)).toBe('p/w/b/t')
    expect(officialTargetOf(officialTabMeta(TARGET))).toEqual(TARGET)
    expect(officialTargetOf(undefined)).toBeUndefined()
    expect(officialTargetOf(null)).toBeUndefined()
    expect(officialTargetOf({ official: 'nope' })).toBeUndefined()
    expect(officialTargetOf({ official: { ...TARGET, tabId: '' } })).toBeUndefined()
    expect(officialTargetOf({ official: { ...TARGET, profileId: '' } })).toBeUndefined()
    expect(officialTargetOf({ official: { ...TARGET, workspaceId: '' } })).toBeUndefined()
    expect(officialTargetOf({ official: { ...TARGET, browserId: '' } })).toBeUndefined()
    expect(officialTargetOf({ official: { profileId: 'p', workspaceId: 'w', browserId: 1, tabId: 't' } })).toBeUndefined()
  })

  it('round-trips only complete Runtime Profile identities', () => {
    expect(officialProfileOf(undefined)).toBeUndefined()
    expect(officialProfileOf({ profile: null })).toBeUndefined()
    expect(officialProfileOf({ profile: 'shared' })).toBeUndefined()
    expect(officialProfileOf(officialTabMeta(TARGET, { kind: 'temporary' }))).toEqual({ kind: 'temporary' })
    expect(officialProfileOf(officialTabMeta(TARGET, { kind: 'shared' }))).toEqual({ kind: 'shared' })
    expect(officialProfileOf(officialTabMeta(TARGET, { kind: 'persistent', name: 'test' }))).toEqual({
      kind: 'persistent',
      name: 'test',
    })
    expect(officialProfileOf({ profile: { kind: 'persistent', name: '' } })).toBeUndefined()
    expect(officialProfileFromChrome({ kind: 'persistent', name: 'test' })).toEqual({
      kind: 'persistent',
      name: 'test',
    })
    expect(officialProfileFromChrome({ kind: 'persistent' })).toBeUndefined()
  })
})
