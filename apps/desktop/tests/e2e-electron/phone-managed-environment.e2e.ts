/** Built Desktop managed-runtime journey over a loopback ZIP fixture. */

import { browser, expect } from '@wdio/globals'
import {
  assertPhoneDevicesSettingsSection, assertStartupEvidence, fakeCounters, recordOwnedProcesses,
  saveWindowEvidence, switchToDesktopOverlay, writeArtifact,
} from './helpers.ts'

interface HttpEvidence {
  readonly url: string
  readonly status: number
  readonly body: unknown
}

async function get(path: string): Promise<HttpEvidence> {
  const result: HttpEvidence = await browser.execute(async (pathname: string) => {
    const url = new URL(pathname, location.origin)
    const response = await fetch(url)
    const body: unknown = await response.json()
    return { url: url.href, status: response.status, body }
  }, path)
  return result
}

describe('Desktop managed mobilecli environment', () => {
  it('prepares a missing runtime, hot-activates tools, and stops them on disable', async () => {
    const startup = await assertStartupEvidence()
    await assertPhoneDevicesSettingsSection()

    const before = await get('/phone/environment')
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({
      enabled: true,
      runtime: { kind: 'missing', targetVersion: '1.0.5' },
    })
    await browser.$('button=准备 mobilecli').click()
    const ready = browser.$('[data-phone-runtime="ready"]')
    await ready.waitForDisplayed({ timeout: 30_000 })
    expect(await ready.getText()).toContain('已就绪 · v1.0.5 · managed')

    const environmentReady = await get('/phone/environment')
    expect(environmentReady).toMatchObject({ status: 200, body: { enabled: true, runtime: {
      kind: 'ready', version: '1.0.5', source: 'managed',
    } } })
    const devicesReady = await get('/phone/devices')
    expect(devicesReady.status).toBe(200)
    const counters = await fakeCounters()
    expect(counters.requests).toBeGreaterThan(0)
    expect((devicesReady.body as { android: readonly unknown[] }).android.length).toBeGreaterThan(0)
    await recordOwnedProcesses(startup.hostPid, true)
    await writeArtifact('managed-phone-ready.json', { before, environmentReady, devicesReady, counters })
    await saveWindowEvidence('managed-phone-ready-window')

    await switchToDesktopOverlay()
    await browser.$('//label[.//input[@role="switch" and @aria-label="启用手机设备"]]').click()
    await browser.waitUntil(async () => {
      const snapshot = await get('/phone/environment')
      return (snapshot.body as { enabled?: boolean }).enabled === false
    }, { timeout: 20_000, timeoutMsg: 'phone environment did not commit the disabled gate' })
    await browser.waitUntil(async () => {
      try {
        await fakeCounters()
        return false
      } catch {
        return true
      }
    }, { timeout: 20_000, interval: 200, timeoutMsg: 'managed mobilecli child survived disable' })
    const devicesDisabled = await get('/phone/devices')
    expect(devicesDisabled.status).not.toBe(200)
    await writeArtifact('managed-phone-disabled.json', {
      environment: await get('/phone/environment'), devices: devicesDisabled,
    })
  })
})
