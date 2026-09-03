/** PHONE_UNRESOLVED remains a rendered arm rather than a dead Desktop Host. */
import { browser, expect } from '@wdio/globals'
import {
  assertStartupEvidence, openPhoneTabFromPlusMenu, openSession, recordOwnedProcesses, saveWindowEvidence,
} from './helpers.ts'

describe('Desktop phone tab when mobilecli is unresolvable', () => {
  it('boots the Desktop Host and renders managed mobilecli preparation guidance', async () => {
    const startup = await assertStartupEvidence()
    await recordOwnedProcesses(startup.hostPid, false)
    await openSession()
    await openPhoneTabFromPlusMenu()
    const title = browser.$('p*=未找到 mobilecli')
    await title.waitForDisplayed({ timeout: 30_000 })
    expect(await browser.execute(() => document.body.innerText.includes('设置 → 手机设备'))).toBe(true)
    expect(await browser.execute(() => document.body.innerText.includes('npm install -g mobilecli'))).toBe(false)
    expect(await browser.execute(() => document.body.innerText.includes('Web Host exited'))).toBe(false)
    await saveWindowEvidence('phone-unresolved-window')
  })
})
