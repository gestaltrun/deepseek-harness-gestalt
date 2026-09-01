/** Full built Desktop Host journey for the singleton phone tab. */
import { browser, expect } from '@wdio/globals'
import {
  assertPhoneDevicesSettingsSection, assertStartupEvidence, fakeCounters, openPhoneTabFromPlusMenu,
  clickSurfaceButton, openSession, phoneTabTitles, recordOwnedProcesses, saveWindowEvidence,
  switchToSessionSurface, waitForFakeIo, writeArtifact,
} from './helpers.ts'

describe('Desktop phone tab live chain', () => {
  it('deduplicates devices, falls back to MJPEG, keeps H264 success, and forwards exact io', async () => {
    const startup = await assertStartupEvidence()
    await recordOwnedProcesses(startup.hostPid, true)
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
    expect(picker.text.match(/Pixel_6_API_35/gu)).toHaveLength(1)
    expect(picker.text).not.toContain('duplicate upstream row')
    await writeArtifact('phone-picker.json', picker)
    expect(picker.text).toContain('真机未授权调试')
    await saveWindowEvidence('phone-picker-window')

    await clickSurfaceButton('iOS')
    await expect(browser.$('div*=iPhone 16')).toBeExisting()
    await clickSurfaceButton('Android')
    await clickSurfaceButton('打开')

    const screen = browser.$('div[role="application"]')
    await screen.waitForExist({ timeout: 30_000 })
    await expect(browser.$('[aria-label="当前画面编码 MJPEG"]')).toBeExisting()
    const live = browser.$('img[alt="Pixel_6_API_35 实时画面"]')
    await live.waitForExist({ timeout: 30_000 })
    const lastPicture = await waitForMjpegPicture('Pixel_6_API_35')
    const transport = await browser.execute(async () => {
      const resource = performance.getEntriesByType('resource').find((entry) => {
        const url = new URL(entry.name)
        return url.pathname.startsWith('/phone/stream/') && url.pathname.endsWith('/h264')
      })
      if (resource === undefined) return undefined
      const url = new URL(resource.name)
      const response = await fetch(url)
      const body = new Uint8Array(await response.arrayBuffer())
      const text = new TextDecoder().decode(body)
      return {
        path: url.pathname,
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes: body.length,
        annexB: body.length >= 4 && body[0] === 0 && body[1] === 0
          && (body[2] === 1 || (body[2] === 0 && body[3] === 1)),
        upstreamError: text === 'Error: Error 0x80001001',
      }
    })
    await writeArtifact('h264-transport.json', transport)
    const visibility = await browser.execute(() => ({
      mjpegPresent: document.querySelector('img[alt="Pixel_6_API_35 实时画面"]') !== null,
      text: document.body.innerText,
    }))
    await writeArtifact('mjpeg-fallback-visibility.json', { lastPicture, ...visibility })
    await saveWindowEvidence('phone-mjpeg-fallback-visibility-window')
    expect(transport).toMatchObject({
      status: 200, contentType: 'video/h264', annexB: false, upstreamError: true,
    })
    expect(transport?.bytes ?? 0).toBeGreaterThan(0)
    expect(lastPicture?.width ?? 0).toBe(390)
    expect(lastPicture?.height ?? 0).toBe(844)
    expect(lastPicture?.display).toBe('block')
    expect(lastPicture?.visibility).toBe('visible')
    expect(lastPicture?.opacity).toBe(1)
    expect(lastPicture.renderedWidth).toBeGreaterThan(0)
    expect(lastPicture.renderedHeight).toBeGreaterThan(0)
    await saveWindowEvidence('phone-live-mjpeg-fallback-window')

    await clickSurfaceButton('切换设备：Pixel_6_API_35')
    const menuItems = await browser.$$('[role="menu"] [role="menuitem"]').getElements()
    const names = await menuItems.map(async item => await item.getText())
    expect(names.some(name => name.includes('Pixel_6_API_35'))).toBe(true)
    expect(names.some(name => name.includes('SM-S9310'))).toBe(true)
    expect(names.some(name => name.includes('iPhone 16'))).toBe(true)
    expect(names.some(name => name.includes('Offline Pixel'))).toBe(false)
    expect(names.some(name => name.includes('Unauthorized Android'))).toBe(false)
    await clickSurfaceButton('iPhone 16切换')
    await browser.$('button[aria-label="切换设备：iPhone 16"]').waitForExist({ timeout: 30_000 })
    expect(await phoneTabTitles()).toEqual(['手机·iPhone 16'])
    await waitForMjpegPicture('iPhone 16')
    await expect(browser.$('[aria-label="当前画面编码 MJPEG"]')).toBeExisting()
    await saveWindowEvidence('phone-iphone-window')

    const beforeTap = await fakeCounters()
    await browser.execute(() => {
      const target = document.querySelector<HTMLDivElement>('div[role="application"]')
      const surface = target?.querySelector<HTMLCanvasElement | HTMLImageElement>('canvas, img')
      if (target === null || target === undefined || surface === null || surface === undefined) {
        throw new Error('phone surface is required')
      }
      target.addEventListener('pointerdown', (event) => {
        const rect = target.getBoundingClientRect()
        const u = (event.clientX - rect.left) / rect.width
        const v = (event.clientY - rect.top) / rect.height
        const width = surface instanceof HTMLImageElement ? surface.naturalWidth : surface.width
        const height = surface instanceof HTMLImageElement ? surface.naturalHeight : surface.height
        Object.assign(window, {
          __DSH_PHONE_E2E_POINTER__: {
            u, v, x: Math.round(u * width), y: Math.round(v * height),
          },
        })
      }, { capture: true, once: true })
    })
    await screen.click()
    const afterTap = await waitForFakeIo(counters => counters.io.length === beforeTap.io.length + 1)
    const pointer = await browser.execute(() => (
      window as typeof window & {
        __DSH_PHONE_E2E_POINTER__?: { readonly u: number; readonly v: number; readonly x: number; readonly y: number }
      }
    ).__DSH_PHONE_E2E_POINTER__)
    if (pointer === undefined) throw new Error('phone surface did not receive pointerdown')
    expect(pointer.u).toBeGreaterThan(0.49)
    expect(pointer.u).toBeLessThan(0.51)
    expect(pointer.v).toBeGreaterThan(0.49)
    expect(pointer.v).toBeLessThan(0.51)
    expect(afterTap.io.at(-1)).toMatchObject({
      method: 'device.io.tap',
      params: { deviceId: '8294A429-4C99-411F-A46D-0AD9499B7FDD', x: pointer.x, y: pointer.y },
    })

    const beforeHome = afterTap.io.length
    await browser.$('button[aria-label="主屏幕"]').click()
    const afterHome = await waitForFakeIo(counters => counters.io.length === beforeHome + 1)
    expect(afterHome.io.at(-1)).toMatchObject({
      method: 'device.io.button',
      params: { deviceId: '8294A429-4C99-411F-A46D-0AD9499B7FDD', button: 'HOME' },
    })

    const beforeAgent = afterHome.io.length
    const composer = browser.$('textarea')
    await composer.waitForDisplayed({ timeout: 20_000 })
    await composer.setValue('Use device_act to press Home on the active iOS Simulator.')
    await composer.click()
    await browser.keys(['Enter'])
    const allow = browser.$('button=允许一次')
    await allow.waitForDisplayed({ timeout: 30_000 })
    await saveWindowEvidence('phone-agent-device-act-approval-window')
    await allow.click()
    const afterAgent = await waitForFakeIo(counters => counters.io.length === beforeAgent + 1)
    expect(afterAgent.io.at(-1)).toMatchObject({
      method: 'device.io.button',
      params: { deviceId: '8294A429-4C99-411F-A46D-0AD9499B7FDD', button: 'HOME' },
    })
    await writeArtifact('ios-control-chain.json', {
      encoding: 'MJPEG', gui: afterHome.io.slice(-2), agent: afterAgent.io.at(-1),
    })

    await clickSurfaceButton('切换设备：iPhone 16')
    await clickSurfaceButton('Pixel_6_API_35切换')
    await browser.$('button[aria-label="切换设备：Pixel_6_API_35"]').waitForExist({ timeout: 30_000 })
    expect(await phoneTabTitles()).toEqual(['手机·Pixel_6_API_35'])
    await waitForMjpegPicture('Pixel_6_API_35')
    await expect(browser.$('[aria-label="当前画面编码 MJPEG"]')).toBeExisting()
    await saveWindowEvidence('phone-pixel-return-window')

    const captureResources = await browser.execute(() => performance.getEntriesByType('resource')
      .map(entry => new URL(entry.name))
      .filter(url => url.pathname.startsWith('/phone/stream/'))
      .map(url => ({ path: url.pathname })))
    await writeArtifact('phone-capture-resources.json', captureResources)
    expect(captureResources.length).toBeGreaterThan(0)
    expect(captureResources.some(resource => resource.path.endsWith('/h264'))).toBe(true)
    expect(captureResources.some(resource => resource.path.endsWith('/mjpeg'))).toBe(true)
    const captureCounters = await fakeCounters()
    expect(captureCounters.captures.slice(0, 2)).toEqual([
      { deviceId: 'emulator-5554', format: 'avc' },
      { deviceId: 'emulator-5554', format: 'mjpeg' },
    ])
    expect(captureCounters.captures).toContainEqual({
      deviceId: '8294A429-4C99-411F-A46D-0AD9499B7FDD', format: 'mjpeg',
    })

    await assertPhoneDevicesSettingsSection()
    await switchToSessionSurface()
    await saveWindowEvidence('phone-complete-window')
  })
})

async function waitForMjpegPicture(label: string): Promise<NonNullable<Awaited<ReturnType<typeof readMjpegPicture>>>> {
  let picture: Awaited<ReturnType<typeof readMjpegPicture>>
  await browser.waitUntil(async () => {
    picture = await readMjpegPicture(label)
    return picture?.width === 390 && picture.height === 844
      && picture.renderedWidth > 0 && picture.renderedHeight > 0
  }, { timeout: 10_000, interval: 250, timeoutMsg: `${label} did not render a 390x844 MJPEG picture` })
  if (picture === undefined) throw new Error(`${label} MJPEG picture disappeared after readiness`)
  return picture
}

async function readMjpegPicture(label: string) {
  return await browser.execute((name: string) => {
    const image = document.querySelector<HTMLImageElement>(`img[alt="${name} 实时画面"]`)
    if (image === null) return undefined
    const style = getComputedStyle(image)
    const rect = image.getBoundingClientRect()
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
    }
  }, label)
}
