import { describe, expect, it } from 'vitest'
import { parseMobileInstallationPresentation } from '@deepseek-ai/dsh-platform-account'

describe('parseMobileInstallationPresentation', () => {
  it('accepts a bounded device-owned iOS or Android presentation', () => {
    expect(parseMobileInstallationPresentation({
      name: 'Yishu mobile installation',
      platform: 'ios',
    })).toEqual({ name: 'Yishu mobile installation', platform: 'ios' })
    expect(parseMobileInstallationPresentation({
      name: 'Pixel work installation',
      platform: 'android',
    })).toEqual({ name: 'Pixel work installation', platform: 'android' })
  })

  it.each([
    [{ name: '', platform: 'ios' }, 'name'],
    [{ name: ' '.repeat(3), platform: 'android' }, 'name'],
    [{ name: 'x'.repeat(129), platform: 'ios' }, 'name'],
    [{ name: 'Browser', platform: 'web' }, 'platform'],
    [{ name: 'Browser' }, 'platform'],
  ])('rejects invalid Mobile Installation presentation %#', (value, field) => {
    expect(() => parseMobileInstallationPresentation(value)).toThrow(field)
  })
})
