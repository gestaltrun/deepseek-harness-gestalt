import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/phone-stream-fallback', import.meta.url))
const EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const MJPEG = Buffer.concat([
  Buffer.from('--frame\r\nContent-Type: image/png\r\nContent-Length: '),
  Buffer.from(String(PNG.length)),
  Buffer.from('\r\n\r\n'),
  PNG,
  Buffer.from('\r\n--frame--\r\n'),
])

function seedLog(): string {
  const time = 1784974100000
  const at = (index: number, event: Record<string, unknown>): string =>
    JSON.stringify({ ...event, seq: index, time: time + index })
  return [
    JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: time, cwd: '{{cwd}}' }),
    at(0, { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } }),
    at(1, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Phone stream snapshot.' }], source: { kind: 'user', rpcId: 'seed' } },
      surfaceOp: 'append',
    }),
    at(2, { type: 'session/title', data: { title: 'Phone stream snapshot', messageSeqs: [1], source: { kind: 'fallback' } } }),
    at(3, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')
}

async function capturePhoneState(
  page: Page,
  scaffold: WebScaffold,
  stage: 'before' | 'after' | 'simulator',
): Promise<string> {
  const root = page.locator('[data-phone-connected]')
  const state = await root.evaluate((element) => {
    const chip = element.querySelector<HTMLElement>('[aria-label^="当前画面编码"]')
    const renderer = element.querySelector('canvas, img')
    const label = chip?.getAttribute('aria-label') ?? ''
    return {
      format: label.includes('MJPEG') ? 'MJPEG' : 'H264',
      renderer: renderer?.tagName.toLowerCase() ?? 'missing',
    }
  })
  const aria = await captureStableAria(page, '[data-phone-connected]', scaffold.workspaceCwd)
  return `${stage}: format=${state.format} renderer=${state.renderer}\n${aria}`
}

describe('web e2e: phone H264 fallback', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let releaseH264: () => void
  let iosSimulatorH264Requests = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.settings.update(settingsNamespace('ui-phone'), { enabled: true })
    await seedSession(scaffold, seedLog(), 'phone-fallback')
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    await page.routeWebSocket('**/phone/ws/io', () => undefined)
    await page.route('**/phone/devices', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        android: [{ id: 'android-real', name: 'Android Real', kind: 'real', state: 'online', online: true }],
        ios: {
          simulators: [{ id: 'ios-simulator', name: 'iOS Simulator', kind: 'simulator', state: 'online', online: true }],
          reals: [],
        },
      }),
    }))
    await page.route('**/phone/session', (route) => {
      const { deviceId } = route.request().postDataJSON() as { readonly deviceId: string }
      const simulator = deviceId === 'ios-simulator'
      const token = simulator ? 'y' : 'x'
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          deviceId, ioPath: '/phone/ws/io', agentManaged: false,
          preferredFormat: simulator ? 'mjpeg' : 'h264',
          h264: { url: `/phone/stream/${deviceId}/h264?token=${token}`, expiresAt: Date.now() + 60_000 },
          mjpeg: { url: `/phone/stream/${deviceId}/mjpeg?token=${token}`, expiresAt: Date.now() + 60_000 },
        }),
      })
    })
    const blocked = new Promise<void>((resolve) => { releaseH264 = resolve })
    await page.route('**/phone/stream/android-real/h264?token=x', async (route) => {
      await blocked
      await route.fulfill({ status: 200, contentType: 'video/h264', body: 'Error: Error 0x80001001' })
    })
    await page.route('**/phone/stream/android-real/mjpeg?token=x', route => route.fulfill({
      status: 200,
      contentType: 'multipart/x-mixed-replace; boundary=frame',
      body: MJPEG,
    }))
    await page.route('**/phone/stream/ios-simulator/h264?token=y', (route) => {
      iosSimulatorH264Requests += 1
      return route.abort()
    })
    await page.route('**/phone/stream/ios-simulator/mjpeg?token=y', route => route.fulfill({
      status: 200,
      contentType: 'multipart/x-mixed-replace; boundary=frame',
      body: MJPEG,
    }))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const workspaceRow = page.locator('[role="treeitem"]').first()
    await workspaceRow.waitFor({ timeout: 15_000 })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps H264 first for real devices and skips known-failing AVC on iOS Simulator', async () => {
    const expand = page.getByRole('button', { name: /展开侧边栏|Expand sidebar/ })
    await expand.waitFor({ timeout: 10_000 })
    await expand.click()
    const newTab = page.getByRole('button', { name: /新.*标签|New tab/ }).last()
    await newTab.waitFor({ timeout: 10_000 })
    await newTab.click()
    const phoneItem = page.getByRole('menuitem', { name: '手机' })
    await phoneItem.waitFor({ timeout: 10_000 })
    await phoneItem.click()
    const open = page.getByRole('button', { name: '打开', exact: true })
    await open.waitFor({ timeout: 10_000 })
    await open.click()
    await page.getByLabel('当前画面编码 H264 · 30 fps').waitFor({ timeout: 10_000 })
    const before = await capturePhoneState(page, scaffold, 'before')
    releaseH264()
    await page.getByLabel('当前画面编码 MJPEG').waitFor({ timeout: 10_000 })
    await page.getByRole('img', { name: 'Android Real 实时画面' }).waitFor()
    const after = await capturePhoneState(page, scaffold, 'after')
    await page.getByRole('button', { name: '切换设备：Android Real' }).click()
    await page.getByRole('menuitem', { name: /iOS Simulator/ }).click()
    await page.getByLabel('当前画面编码 MJPEG').waitFor({ timeout: 10_000 })
    await page.getByRole('img', { name: 'iOS Simulator 实时画面' }).waitFor()
    const simulator = await capturePhoneState(page, scaffold, 'simulator')
    expect(iosSimulatorH264Requests).toBe(0)
    await compareOrRefreshGolden(EXPECTED, `${before}\n${after}\n${simulator}`, MODE)
  }, 30_000)
})
