/** Release-backed Electron flow: Settings offer, installer, Web Host restart, embedded console. */
import { browser, expect } from '@wdio/globals'
import {
  clickOverlayButton, configureRealModelRoute, connectTemporaryWorkspace, mainWindowSnapshot, navigateMainWindow,
  openSettings, overlayText, recordOwnedProcesses, recordReleaseChecksums, selectModelAndSend, sub2apiSnapshot,
  waitForSessionSurface,
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
    await clickOverlayButton(['账号池', 'Account pool'])
    await clickOverlayButton(['打开账号台', 'Open account console'])
    await browser.waitUntil(async () => (await mainWindowSnapshot()).text.includes('Sub2API'), {
      timeout: 60_000,
      timeoutMsg: 'Desktop did not navigate to the embedded Sub2API console',
    })
    const consoleWindow = await mainWindowSnapshot()
    // The sidecar shim loads through the host prefix, then exposes the
    // unprefixed inner route required by the upstream absolute-base router.
    expect(new URL(consoleWindow.url).pathname).toBe('/home')
    expect(consoleWindow.text).toContain('Sub2API')
    await navigateMainWindow(hostSurface.url)
    await waitForSessionSurface()
    await connectTemporaryWorkspace()
    const expected = 'DSH445_MODEL_OK_7F3A'
    await selectModelAndSend('Claude Sonnet 4.5', `Reply with exactly ${expected} and no other text.`, expected)
    await recordOwnedProcesses()
  })
})
