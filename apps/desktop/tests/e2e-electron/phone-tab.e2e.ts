/** Full built Desktop Host journey for the singleton phone tab. */
import { browser, expect } from '@wdio/globals'
import {
  assertPhoneDevicesSettingsSection, assertStartupEvidence, fakeCounters, openPhoneTabFromPlusMenu,
  clickSurfaceButton, openSession, phoneTabTitles, recordOwnedProcesses, saveWindowEvidence,
  switchToSessionSurface, waitForFakeIo, writeArtifact,
} from './helpers.ts'

describe('Desktop phone tab live chain', () => {
  it('renders a 390x844 H264 picture and forwards exact tap and Home io', async () => {
    const startup = await assertStartupEvidence()
    await openSession()
    await openPhoneTabFromPlusMenu()

    const android = browser.$('button=Android')
    await android.waitForDisplayed({ timeout: 20_000 })
    await browser.$('div*=Pixel_6_API_35').waitForDisplayed({ timeout: 30_000 })
    await expect(browser.$('div*=SM-S9310')).toBeDisplayed()
    await expect(browser.$('section[aria-label="模拟器"]')).toBeDisplayed()
    await expect(browser.$('section[aria-label="USB 真机"]')).toBeDisplayed()
    await expect(browser.$('div*=Offline Pixel')).not.toBeExisting()
    const picker = await browser.execute(() => ({
      text: document.body.innerText,
      alerts: [...document.querySelectorAll<HTMLElement>('[role="alert"]')].map(element => element.innerText),
    }))
    await writeArtifact('phone-picker.json', picker)
    expect(picker.text).toContain('真机未授权调试')
    await recordOwnedProcesses(startup.hostPid, true)

    await clickSurfaceButton('iOS')
    await expect(browser.$('div*=iPhone 16')).toBeExisting()
    await clickSurfaceButton('Android')
    await clickSurfaceButton('打开')

    const screen = browser.$('div[role="application"]')
    await screen.waitForExist({ timeout: 30_000 })
    await expect(browser.$('[aria-label="当前画面编码 H264 · 30 fps"]')).toBeExisting()
    const live = browser.$('img[aria-label="Pixel_6_API_35 实时画面"]')
    await live.waitForExist({ timeout: 30_000 })
    const initialPicture = await readPicture()
    const transport = await browser.execute(async () => {
      const image = document.querySelector<HTMLImageElement>('img[aria-label="Pixel_6_API_35 实时画面"]')
      if (image === null) return undefined
      const url = new URL(image.src)
      const response = await fetch(url)
      const body = new Uint8Array(await response.arrayBuffer())
      return {
        path: url.pathname,
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes: body.length,
        annexB: body.length >= 4 && body[0] === 0 && body[1] === 0
          && (body[2] === 1 || (body[2] === 0 && body[3] === 1)),
      }
    })
    await writeArtifact('h264-transport.json', transport)
    let picture: Awaited<ReturnType<typeof readPicture>> | undefined
    let lastPicture: typeof picture = initialPicture
    const pictureDeadline = Date.now() + 10_000
    do {
      picture = await readPicture()
      if (picture !== undefined) lastPicture = picture
      if (picture?.naturalWidth === 390 && picture.naturalHeight === 844) break
      await browser.pause(250)
    } while (Date.now() < pictureDeadline)
    const visibility = await browser.execute(() => ({
      imagePresent: document.querySelector('img[aria-label="Pixel_6_API_35 实时画面"]') !== null,
      text: document.body.innerText,
    }))
    await writeArtifact('h264-visibility.json', { lastPicture, ...visibility })
    await saveWindowEvidence('phone-h264-visibility-window')
    expect(transport).toMatchObject({ status: 200, contentType: 'video/h264', annexB: true })
    expect(transport?.bytes ?? 0).toBeGreaterThan(0)
    expect(lastPicture?.naturalWidth ?? 0).toBe(390)
    expect(lastPicture?.naturalHeight ?? 0).toBe(844)
    expect(lastPicture?.display).toBe('block')
    expect(lastPicture?.visibility).toBe('visible')
    expect(lastPicture?.opacity).toBe(1)
    expect(picture?.renderedWidth ?? 0).toBeGreaterThan(0)
    expect(picture?.renderedHeight ?? 0).toBeGreaterThan(0)
    await saveWindowEvidence('phone-live-h264-window')

    await clickSurfaceButton('切换设备：Pixel_6_API_35')
    const names = await browser.$$('[role="menu"] [role="menuitem"]').map(async item => await item.getText())
    expect(names.some(name => name.includes('Pixel_6_API_35'))).toBe(true)
    expect(names.some(name => name.includes('SM-S9310'))).toBe(true)
    expect(names.some(name => name.includes('iPhone 16'))).toBe(true)
    expect(names.some(name => name.includes('Offline Pixel'))).toBe(false)
    expect(names.some(name => name.includes('Unauthorized Android'))).toBe(false)
    await clickSurfaceButton('iPhone 16切换')
    await browser.$('button[aria-label="切换设备：iPhone 16"]').waitForExist({ timeout: 30_000 })
    expect(await phoneTabTitles()).toEqual(['手机·iPhone 16'])
    await clickSurfaceButton('切换设备：iPhone 16')
    await clickSurfaceButton('Pixel_6_API_35切换')
    await browser.$('button[aria-label="切换设备：Pixel_6_API_35"]').waitForExist({ timeout: 30_000 })
    expect(await phoneTabTitles()).toEqual(['手机·Pixel_6_API_35'])

    const beforeTap = await fakeCounters()
    const size = await screen.getSize()
    await screen.click({ x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) })
    const afterTap = await waitForFakeIo(counters => counters.io.length === beforeTap.io.length + 1)
    expect(afterTap.io.at(-1)).toMatchObject({
      method: 'device.io.tap',
      params: { deviceId: 'emulator-5554', x: 195, y: 422 },
    })

    const beforeHome = afterTap.io.length
    await browser.$('button[aria-label="主屏幕"]').click()
    const afterHome = await waitForFakeIo(counters => counters.io.length === beforeHome + 1)
    expect(afterHome.io.at(-1)).toMatchObject({
      method: 'device.io.button',
      params: { deviceId: 'emulator-5554', button: 'HOME' },
    })

    await assertPhoneDevicesSettingsSection()
    await switchToSessionSurface()
    await saveWindowEvidence('phone-complete-window')
  })
})

async function readPicture() {
  return await browser.execute(() => {
    const image = document.querySelector<HTMLImageElement>('img[aria-label="Pixel_6_API_35 实时画面"]')
    if (image === null) return undefined
    const style = getComputedStyle(image)
    const rect = image.getBoundingClientRect()
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
    }
  })
}
