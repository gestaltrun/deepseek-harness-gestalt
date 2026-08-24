import { describe, expect, it } from 'vitest'
import { mobileInstallationPresentation } from '../src/mobile-installation.ts'

describe('mobileInstallationPresentation', () => {
  it('uses the native device name and Mobile operating system', () => {
    expect(mobileInstallationPresentation({
      name: 'Yishu device',
      model: 'iPhone17,1',
      platform: 'ios',
      operatingSystem: 'ios',
    })).toEqual({ name: 'Yishu device', platform: 'ios' })
  })

  it('uses the device model when the operating system exposes no personal name', () => {
    expect(mobileInstallationPresentation({
      name: '',
      model: 'Pixel 10 Pro',
      platform: 'android',
      operatingSystem: 'android',
    })).toEqual({ name: 'Pixel 10 Pro', platform: 'android' })
  })

  it('uses the Mobile operating system for a browser-hosted product entry', () => {
    expect(mobileInstallationPresentation({
      name: 'Mobile Safari',
      model: 'iPhone',
      platform: 'web',
      operatingSystem: 'ios',
    })).toEqual({ name: 'Mobile Safari', platform: 'ios' })
  })

  it('rejects a non-Mobile browser instead of inventing a phone identity', () => {
    expect(() => mobileInstallationPresentation({
      name: 'Chrome',
      model: 'Macintosh',
      platform: 'web',
      operatingSystem: 'mac',
    })).toThrow('iOS or Android')
  })
})
