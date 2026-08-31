/** Release-backed Electron flow: Settings offer, installer, Web Host restart, embedded console. */
import { browser, expect } from '@wdio/globals'
import {
  clickAccountConsoleButton, clickAccountConsoleFieldSelector, clickAccountConsoleOption,
  clickAccountConsoleSelector, clickOverlayButton,
  configureRealModelRoute, connectTemporaryWorkspace, mainWindowSnapshot,
  openSettings, overlayAccountConsoleSnapshot, overlayText, overlayUrl, recordOwnedProcesses,
  recordReleaseChecksums, selectModelAndSend, sub2apiSnapshot, waitForSessionSurface,
} from './helpers.ts'

async function disableAndReEnable(cycle: number): Promise<void> {
  await clickOverlayButton(['停用', 'Disable'])
  await browser.waitUntil(async () => {
    const current = await sub2apiSnapshot()
    return (current?.state === 'installed' && !current.enabled) || current?.state === 'error'
  }, { timeout: 120_000, interval: 1_000, timeoutMsg: `Sub2API cycle ${String(cycle)} did not disable after the Host replacement` })
  const disabled = await sub2apiSnapshot()
  if (disabled?.state === 'error') throw new Error(`Sub2API cycle ${String(cycle)} disable failed: ${String(disabled.error)}`)
  expect(disabled).toMatchObject({ state: 'installed', enabled: false })
  expect(await overlayText()).toMatch(/已停用|Disabled/u)

  await clickOverlayButton(['启用', 'Enable'])
  await browser.waitUntil(async () => {
    const current = await sub2apiSnapshot()
    return current?.state === 'running' || current?.state === 'error'
  }, { timeout: 240_000, interval: 1_000, timeoutMsg: `Sub2API cycle ${String(cycle)} did not re-enable after the Host replacement` })
  const reenabled = await sub2apiSnapshot()
  if (reenabled?.state === 'error') throw new Error(`Sub2API cycle ${String(cycle)} re-enable failed: ${String(reenabled.error)}`)
  expect(reenabled).toMatchObject({ state: 'running', enabled: true })
  await browser.waitUntil(async () => /添加账号|Create Account/u.test((await overlayAccountConsoleSnapshot()).text), {
    timeout: 60_000,
    timeoutMsg: `Native Sub2API account workspace did not return after re-enable cycle ${String(cycle)}`,
  })
}

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
    await browser.waitUntil(async () => /添加账号|Create Account/u.test((await overlayAccountConsoleSnapshot()).text), {
      timeout: 60_000,
      timeoutMsg: 'Settings did not render the native Sub2API account workspace by default',
    })

    await disableAndReEnable(1)
    await disableAndReEnable(2)
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
    const consoleWindow = await overlayAccountConsoleSnapshot()
    // The sidecar shim loads through the host prefix. The upstream router may
    // retain that route or expose its absolute-base inner route after boot.
    const consoleUrl = new URL(consoleWindow.url)
    expect([
      '/plugins/dsh-sub2api/ui/admin/accounts',
      '/admin/accounts',
    ]).toContain(consoleUrl.pathname)
    expect(consoleUrl.searchParams.get('embed')).toBe('desktop')
    expect(consoleWindow.text).toMatch(/添加账号|Create Account/u)
    expect(consoleWindow.text).toMatch(/Composite 路由|Composite Routes/u)
    expect((await mainWindowSnapshot()).url).toBe(hostSurface.url)

    await clickAccountConsoleButton(['Composite 路由', 'Composite Routes'])
    await browser.waitUntil(async () => /已保存路由|Saved Routes/u.test((await overlayAccountConsoleSnapshot()).text), {
      timeout: 15_000,
      timeoutMsg: 'Composite route dialog did not open inside the account workspace',
    })
    await clickAccountConsoleButton(['关闭', 'Close'])

    await clickAccountConsoleButton(['添加账号', 'Create Account'])
    await browser.waitUntil(async () => /代理|Proxy/u.test((await overlayAccountConsoleSnapshot()).text), {
      timeout: 15_000,
      timeoutMsg: 'Native add-account dialog did not open',
    })
    await clickAccountConsoleSelector('.select-trigger')
    await clickAccountConsoleOption(['Anthropic'])
    await clickAccountConsoleButton(['下一步', 'Next'])
    await browser.waitUntil(async () => /代理|Proxy/u.test((await overlayAccountConsoleSnapshot()).text), {
      timeout: 15_000,
      timeoutMsg: 'Native account flow did not reach the authorization form',
    })
    await clickAccountConsoleFieldSelector(['代理', 'Proxy'])
    await browser.waitUntil(async () => /代理管理|Proxy Management|IP管理|IP Management/u.test((await overlayAccountConsoleSnapshot()).text), {
      timeout: 15_000,
      timeoutMsg: 'Proxy selector did not expose the integrated IP management entry',
    })
    await clickAccountConsoleSelector('.select-manage')
    await browser.waitUntil(async () => /添加代理|Create Proxy/u.test((await overlayAccountConsoleSnapshot()).text), {
      timeout: 15_000,
      timeoutMsg: 'Integrated IP management did not open inside the account form',
    })
    await clickAccountConsoleButton(['返回', 'Back'])
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
