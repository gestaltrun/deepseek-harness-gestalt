import { describe, expect, it } from 'vitest'
import { prepareRelease } from '../scripts/prepare-release.mjs'

describe('prepareRelease', () => {
  it('derives a release tag from the matching Desktop Bundle version', () => {
    expect(
      prepareRelease({
        requestedVersion: '0.1.0',
        packageVersion: '0.1.0',
        publish: true,
        tagExists: false,
      }),
    ).toEqual({ tag: 'gestalt-v0.1.0', version: '0.1.0' })
  })

  it('rejects a version that does not match the Desktop Bundle', () => {
    expect(() =>
      prepareRelease({
        requestedVersion: '0.2.0',
        packageVersion: '0.1.0',
        publish: false,
        tagExists: false,
      }),
    ).toThrow('does not match')
  })

  it('requires an unused tag for publication', () => {
    const base = {
      requestedVersion: '0.1.0',
      packageVersion: '0.1.0',
      publish: true,
      tagExists: false,
    }
    expect(() => prepareRelease({ ...base, tagExists: true })).toThrow('already exists')
  })

  it('rejects versions outside the supported Desktop Bundle grammar', () => {
    expect(() =>
      prepareRelease({
        requestedVersion: '0.1',
        packageVersion: '0.1',
        publish: false,
        tagExists: false,
      }),
    ).toThrow('supported X.Y.Z version')
  })

  it('allows credential-free dry-run packaging', () => {
    expect(
      prepareRelease({
        requestedVersion: '0.1.0',
        packageVersion: '0.1.0',
        publish: false,
        tagExists: false,
      }),
    ).toEqual({ tag: 'gestalt-v0.1.0', version: '0.1.0' })
  })
})
