/** Built Desktop journey from a compatible Android SDK layout to a running default emulator. */

import { readFile } from 'node:fs/promises'
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

describe('Desktop Android environment preparation', () => {
  it('reuses a compatible SDK and starts the private API 35 AVD', async () => {
    const startup = await assertStartupEvidence()
    await assertPhoneDevicesSettingsSection()
    await browser.$('button=准备 mobilecli').click()
    await browser.$('[data-phone-runtime="ready"]').waitForDisplayed({ timeout: 30_000 })

    const android = browser.$('[data-phone-platform-android="ready"]')
    await android.waitForDisplayed({ timeout: 20_000 })
    expect(await android.getText()).toContain('环境已准备，可启动默认模拟器')
    await android.$('button=启动默认模拟器').click()
    await browser.waitUntil(async () => (await android.getText()).includes('emulator-5554'), {
      timeout: 30_000,
      timeoutMsg: 'Android fixture AVD did not reach the running state',
    })
    const environment = await get('/phone/environment')
    expect(environment).toMatchObject({ status: 200, body: { platforms: { android: {
      kind: 'ready', running: true, deviceId: 'emulator-5554',
    } } } })
    const devices = await get('/phone/devices')
    expect(devices.status).toBe(200)
    const pidFile = process.env.DSH_ANDROID_E2E_PID_FILE
    if (pidFile === undefined) throw new Error('DSH_ANDROID_E2E_PID_FILE is required')
    const androidEmulatorPid = Number((await readFile(pidFile, 'utf8')).trim())
    if (!Number.isSafeInteger(androidEmulatorPid) || androidEmulatorPid < 1) throw new Error('Android fixture PID is invalid')
    await recordOwnedProcesses(startup.hostPid, true, { androidEmulatorPid })
    await writeArtifact('android-environment-ready.json', { environment, devices, androidEmulatorPid })
    await saveWindowEvidence('android-environment-ready-window')
  })
})
