import { describe, expect, it } from 'vitest'
import { classifyRealDeviceIssue } from '../src/classify.ts'

describe('classifyRealDeviceIssue', () => {
  it('classifies the five structured real-device failure arms', () => {
    expect(classifyRealDeviceIssue('the device is locked; unlock it and try again')).toBe('device-locked')
    expect(classifyRealDeviceIssue('Device Passcode is required before installing')).toBe('device-locked')
    expect(classifyRealDeviceIssue('failed to re-sign the agent: provisioning profile has expired')).toBe('profile-expired')
    expect(classifyRealDeviceIssue('profile expired on the device')).toBe('profile-expired')
    expect(classifyRealDeviceIssue('Untrusted Developer: enable Developer Mode to install')).toBe('cert-untrusted')
    expect(classifyRealDeviceIssue('codesign failed: no signing identity matches')).toBe('cert-untrusted')
    expect(classifyRealDeviceIssue('the device tunnel could not be established')).toBe('tunnel-failed')
    expect(classifyRealDeviceIssue('the device was unplugged mid-install')).toBe('device-unplugged')
    expect(classifyRealDeviceIssue('device disconnected while the request was in flight')).toBe('device-unplugged')
  })

  it('names the expired profile over certificate wording when both appear', () => {
    expect(classifyRealDeviceIssue('codesign failed: provisioning profile expired')).toBe('profile-expired')
  })

  it('leaves unrelated failures unclassified', () => {
    expect(classifyRealDeviceIssue('--provisioning-profile is required for real iOS devices')).toBeUndefined()
    expect(classifyRealDeviceIssue('agent was installed but could not be found')).toBeUndefined()
    expect(classifyRealDeviceIssue('')).toBeUndefined()
  })
})
