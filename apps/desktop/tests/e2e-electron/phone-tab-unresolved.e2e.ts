/** PHONE_UNRESOLVED remains a rendered arm rather than a dead Desktop Host. */
import { browser, expect } from '@wdio/globals'
import {
  assertStartupEvidence, openPhoneTabFromPlusMenu, openSession, recordOwnedProcesses, saveWindowEvidence,
} from './helpers.ts'

describe('Desktop phone tab when mobilecli is unresolvable', () => {
  it('boots the Desktop Host and renders mobilecli installation guidance', async () => {
    const startup = await assertStartupEvidence()
    await openSession()
    await openPhoneTabFromPlusMenu()
    const title = browser.$('p*=未找到 mobilecli')
    await title.waitForDisplayed({ timeout: 30_000 })
    await expect(browser.$('code*=npm install -g mobilecli@latest')).toBeDisplayed()
    expect(await browser.execute(() => document.body.innerText.includes('Web Host exited'))).toBe(false)
    await recordOwnedProcesses(startup.hostPid, false)
    await saveWindowEvidence('phone-unresolved-window')
  })
})
