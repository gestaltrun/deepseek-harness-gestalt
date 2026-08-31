/** Release-backed Electron flow: Settings offer, installer, Web Host restart, embedded console. */
import { browser, expect } from '@wdio/globals'
import {
  clickOverlayButton, configureRealModelRoute, connectTemporaryWorkspace, mainWindowSnapshot,
  openSettings, overlayAccountConsoleSnapshot, overlayText, overlayUrl, recordOwnedProcesses,
  recordReleaseChecksums, selectModelAndSend, sub2apiSnapshot, waitForSessionSurface,
} from './helpers.ts'

describe('Sub2API Desktop installation', () => {
  it('installs the release, opens the console, selects Sub2API, and receives a real reply', async () => {
    await waitForSessionSurface()
    await recordReleaseChecksums()
    await openSettings()
    await clickOverlayButton(['账号池', 'Account pool'])
    expect(await overlayText()).toMatch(/Sub2API/u)
    const initial = await sub2apiSnapshot()
    if (initial?.state === 'error') throw new Error(`Sub2API initial state failed: ${String(initial.error)}`)
    expect(initial).toMatchObject({ state: 'missing', enabled: true })

    await clickOverlayButton(['下载并启用', 'Download and enable'])
    await browser.waitUntil(async () => {
      const snapshot = await sub2apiSnapshot()
      return snapshot?.state === 'running' || snapshot?.state === 'error'
    }, {
      timeout: 720_000,
      interval: 1_000,
      timeoutMsg: 'Sub2API did not reach a terminal startup state',
    })
    const snapshot = await sub2apiSnapshot()
    if (snapshot?.state === 'error') throw new Error(`Sub2API startup failed: ${String(snapshot.error)}`)
    expect(snapshot).toMatchObject({ state: 'running', enabled: true })
    const hostSurface = await mainWindowSnapshot()
    await configureRealModelRoute(new URL(hostSurface.url).origin)

    await openSettings()
    expect(new URL(await overlayUrl()).origin).toBe(new URL(hostSurface.url).origin)
    await clickOverlayButton(['模型', 'Models'])
    await browser.waitUntil(async () => {
      const text = await overlayText()
      return /添加提供方|Add provider/u.test(text)
        || /加载提供方目录失败|Loading the provider directory failed/u.test(text)
    }, { timeout: 30_000, timeoutMsg: 'Models Settings did not settle after the Web Host replacement' })
    const modelsText = await overlayText()
    expect(modelsText).toMatch(/添加提供方|Add provider/u)
    expect(modelsText).not.toMatch(/加载提供方目录失败|Loading the provider directory failed/u)

    await clickOverlayButton(['账号池', 'Account pool'])
    await clickOverlayButton(['打开账号台', 'Open account console'])
    await browser.waitUntil(async () => (await overlayAccountConsoleSnapshot()).text.includes('Sub2API'), {
      timeout: 60_000,
      timeoutMsg: 'Settings did not render the embedded Sub2API account console',
    })
    const consoleWindow = await overlayAccountConsoleSnapshot()
    // The sidecar shim loads through the host prefix, then exposes the
    // unprefixed inner route required by the upstream absolute-base router.
    expect(new URL(consoleWindow.url).pathname).toBe('/home')
    expect(consoleWindow.text).toContain('Sub2API')
    expect((await mainWindowSnapshot()).url).toBe(hostSurface.url)
    await clickOverlayButton(['关闭账号台', 'Close account console'])
    await clickOverlayButton(['关闭', 'Close'])
    await waitForSessionSurface(hostSurface.url)
    await connectTemporaryWorkspace()
    const expected = 'DSH445_MODEL_OK_7F3A'
    await selectModelAndSend(
      'Claude Sonnet 4.5',
      `Reply with exactly ${expected} and no other text.`,
      expected,
      hostSurface.url,
    )
    await recordOwnedProcesses()
  })
})
