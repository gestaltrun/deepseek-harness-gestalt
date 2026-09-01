/** Release-backed Electron flow: Settings offer, installer, Web Host restart, embedded console. */
import { browser, expect } from '@wdio/globals'
import {
  ACCOUNT_PROVIDER_MODEL, clickAccountConsoleButton, clickAccountConsoleFieldSelector, clickAccountConsoleOption,
  clickAccountConsoleRowAction, clickAccountConsoleSelector, clickOverlayButton, clickTopAccountDialogButton,
  configureRealModelRoute, connectTemporaryWorkspace, expandProviderSettings, fillTopAccountDialogInput,
  gatewayModelProfile, mainWindowSnapshot,
  openProviderEditor,
  openSettings, overlayAccountConsoleSnapshot, overlayAccountDialogStack, overlayAccountWorkspaceLayout,
  overlayAccountSelectOptions, overlayAccountWorkspaceUi, overlayProviderInputValues, overlayText, overlayUrl, recordOwnedProcesses,
  providerModelProfile, recordReleaseChecksums, selectModelAndSend, sub2apiSnapshot, waitForSessionSurface,
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

    try {
      await browser.waitUntil(async () => {
        const model = await gatewayModelProfile(ACCOUNT_PROVIDER_MODEL)
        return model?.contextWindow !== undefined
          && model.maxTokens !== undefined
          && model.input !== undefined
          && model.reasoningEfforts !== undefined
      }, {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: 'Release-backed Sub2API gateway did not project routed model capability metadata',
      })
    } catch {
      throw new Error(
        `Release-backed Sub2API gateway capability profile: ${JSON.stringify(await gatewayModelProfile(ACCOUNT_PROVIDER_MODEL))}`,
      )
    }

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
    await openProviderEditor(['Sub2API (sub2api)', 'Sub2API'])
    await expandProviderSettings(['自定义设置', 'Customized settings'])
    await browser.waitUntil(async () => (await overlayProviderInputValues()).includes(ACCOUNT_PROVIDER_MODEL), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'Models Settings did not receive the live Sub2API account catalog',
    })
    await browser.waitUntil(async () => {
      const model = await providerModelProfile('claude-sonnet-4-5-20250929')
      return model?.contextWindow !== undefined
        && model.maxTokens !== undefined
        && model.input !== undefined
        && model.reasoningEfforts !== undefined
    }, {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'Sub2API provider did not receive live model capability metadata',
    })
    const providerModel = await providerModelProfile('claude-sonnet-4-5-20250929')
    expect(providerModel?.contextWindow).toBeGreaterThan(0)
    expect(providerModel?.maxTokens).toBeGreaterThan(0)
    expect(providerModel?.input).toContain('text')
    if (providerModel?.reasoningEfforts !== false) {
      expect(Object.keys(providerModel?.reasoningEfforts ?? {})).toContain(providerModel?.defaultReasoningLevel)
    }

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
    const workspaceUi = await overlayAccountWorkspaceUi()
    expect(workspaceUi.text).not.toMatch(/全部分组|All Groups|更多操作|More Actions|批量更新|Batch Update/u)
    expect([
      [
        '名称', '账号ID', '平台/类型', '容量', '状态', '调度', '今日统计', '用量窗口',
        '代理', '优先级', '调度权值', '最近使用', '创建时间', '过期时间', '备注', '操作',
      ],
      [
        'NAME', 'ACCOUNT ID', 'PLATFORM/TYPE', 'CAPACITY', 'STATUS', 'SCHEDULABLE',
        'TODAY STATS', 'USAGE WINDOWS', 'PROXY', 'PRIORITY', 'SCHEDULER SCORE',
        'LAST USED', 'CREATED', 'EXPIRES AT', 'NOTES', 'ACTIONS',
      ],
    ]).toContainEqual(workspaceUi.headers)
    expect((await mainWindowSnapshot()).url).toBe(hostSurface.url)
    const layout = await overlayAccountWorkspaceLayout()
    expect(layout.borderTopWidth).toBe('0px')
    expect(layout.frameHeight + 1).toBeGreaterThanOrEqual(layout.contentHeight)
    expect(layout.settingsOverflowY).toBe('auto')
    expect((layout.tableClientHeight ?? 0) + 1).toBeGreaterThanOrEqual(layout.tableScrollHeight ?? 1)

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
    expect((await overlayAccountConsoleSnapshot()).text).not.toMatch(
      /池模式|Pool Mode|账号计费倍率|Billing Rate Multiplier|自动探测上游声明倍率|Automatically probe upstream declared rate|配额控制|Quota Control/u,
    )
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
    await clickAccountConsoleButton(['添加代理', 'Create Proxy'])
    await browser.waitUntil(async () => {
      const dialogs = await overlayAccountDialogStack()
      return dialogs.some(dialog =>
        /添加代理|Create Proxy/u.test(dialog.text) && dialog.ownsCenter)
    }, {
      timeout: 15_000,
      timeoutMsg: 'Create Proxy dialog did not become the topmost integrated IP-management surface',
    })
    const dialogStack = await overlayAccountDialogStack()
    const createProxyDialog = dialogStack.find(dialog =>
      /添加代理|Create Proxy/u.test(dialog.text) && dialog.ownsCenter)
    expect(createProxyDialog?.zIndex).toBe('80')

    const proxyName = 'dsh-e2e-proxy'
    await fillTopAccountDialogInput(['名称', 'Name'], proxyName)
    await fillTopAccountDialogInput(['主机', 'Host'], '127.0.0.1')
    await fillTopAccountDialogInput(['端口', 'Port'], '9')
    await clickTopAccountDialogButton(['创建', 'Create'])
    await browser.waitUntil(async () => (await overlayAccountConsoleSnapshot()).text.includes(proxyName), {
      timeout: 15_000,
      timeoutMsg: 'New proxy did not appear in integrated IP management',
    })

    await clickAccountConsoleRowAction(proxyName, ['编辑', 'Edit'])
    await browser.waitUntil(async () => {
      const dialogs = await overlayAccountDialogStack()
      return dialogs.some(dialog => /编辑代理|Edit Proxy/u.test(dialog.text) && dialog.ownsCenter)
    }, {
      timeout: 15_000,
      timeoutMsg: 'Edit Proxy dialog did not become the topmost integrated IP-management surface',
    })
    const editProxyDialog = (await overlayAccountDialogStack()).find(dialog =>
      /编辑代理|Edit Proxy/u.test(dialog.text) && dialog.ownsCenter)
    expect(editProxyDialog?.zIndex).toBe('80')
    await clickTopAccountDialogButton(['取消', 'Cancel'])

    await clickAccountConsoleRowAction(proxyName, ['删除', 'Delete'])
    await browser.waitUntil(async () => {
      const dialogs = await overlayAccountDialogStack()
      return dialogs.some(dialog => /删除代理|Delete Proxy/u.test(dialog.text) && dialog.ownsCenter)
    }, {
      timeout: 15_000,
      timeoutMsg: 'Delete Proxy confirmation did not become the topmost integrated IP-management surface',
    })
    const deleteProxyDialog = (await overlayAccountDialogStack()).find(dialog =>
      /删除代理|Delete Proxy/u.test(dialog.text) && dialog.ownsCenter)
    expect(deleteProxyDialog?.zIndex).toBe('80')
    await clickTopAccountDialogButton(['取消', 'Cancel'])

    await clickAccountConsoleButton(['返回', 'Back'])
    await clickAccountConsoleFieldSelector(['代理', 'Proxy'])
    await browser.waitUntil(async () => (await overlayAccountSelectOptions()).some(option => option.includes(proxyName)), {
      timeout: 15_000,
      timeoutMsg: 'Account form did not refresh the proxy catalog after returning from IP management',
    })
    expect((await overlayAccountSelectOptions()).some(option => option.includes(proxyName))).toBe(true)
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
