/** Built Desktop journey from a complete Xcode fixture to a verified iOS Simulator. */

import { browser, expect } from '@wdio/globals'
import {
  assertPhoneDevicesSettingsSection, assertStartupEvidence, recordOwnedProcesses, saveWindowEvidence, writeArtifact,
} from './helpers.ts'

async function get(path: string): Promise<{ status: number; body: unknown }> {
  return await browser.execute(async (pathname: string) => {
    const response = await fetch(new URL(pathname, location.origin))
    return { status: response.status, body: await response.json() }
  }, path)
}

describe('Desktop iOS environment preparation', () => {
  it('prepares the Xcode Runtime and default Simulator without a real Apple download', async () => {
    const startup = await assertStartupEvidence()
    await assertPhoneDevicesSettingsSection()
    await browser.$('button=准备 mobilecli').click()
    await browser.$('[data-phone-runtime="ready"]').waitForDisplayed({ timeout: 30_000 })

    const ios = browser.$('[data-phone-platform-ios="runtime-missing"]')
    await ios.waitForDisplayed({ timeout: 20_000 })
    expect(await ios.getText()).toContain('一键准备 iOS')
    await ios.$('button=一键准备 iOS').click()
    await browser.waitUntil(async () => {
      const ready = browser.$('[data-phone-platform-ios="ready"]')
      return await ready.isDisplayed() && (await ready.getText()).includes('MJPEG 实时画面')
    }, { timeout: 30_000, timeoutMsg: 'iOS fixture Simulator did not reach verified MJPEG readiness' })

    const environment = await get('/phone/environment')
    expect(environment).toMatchObject({ status: 200, body: { platforms: { ios: {
      kind: 'ready', running: true, deviceId: '8294A429-4C99-411F-A46D-0AD9499B7FDD',
    } } } })
    const devices = await get('/phone/devices')
    expect(devices).toMatchObject({ status: 200, body: { ios: { simulators: [{
      id: '8294A429-4C99-411F-A46D-0AD9499B7FDD', online: true,
    }] } } })
    await recordOwnedProcesses(startup.hostPid, true)
    await writeArtifact('ios-environment-ready.json', { environment, devices, stream: 'MJPEG fixture picture' })
    await saveWindowEvidence('ios-environment-ready-window')
  })
})
