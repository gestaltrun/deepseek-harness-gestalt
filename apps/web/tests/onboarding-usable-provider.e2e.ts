// Keyless browser e2e: first-run onboarding opens Settings Models without
// minting official DeepSeek. Configuring another provider ends the prompt.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-usable-provider', import.meta.url))
const DISMISSED_EXPECTED = join(SNAPSHOT_DIR, 'dismissed.expected.md')
const MODE = webSnapshotMode()
const CONFIGURE_STEP = '配置模型即可开始使用'

describe.skipIf(MODE === 'record')('web e2e: another usable provider ends first-run onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens Models without an official DeepSeek row and keeps the add card', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-setup-card-cancel'))
    const configureStep = page.getByRole('dialog', { name: CONFIGURE_STEP })
    await configureStep.waitFor({ timeout: 15_000 })
    await configureStep.getByRole('button', { name: '去配置' }).click()
    await configureStep.waitFor({ state: 'detached', timeout: 15_000 })

    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('heading', { name: '模型' }).waitFor({ timeout: 10_000 })
    expect(await settings.getByText('DeepSeek', { exact: true }).count()).toBe(0)
    expect(await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(0)

    const add = settings.getByRole('button', { name: '添加提供方' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = settings.getByLabel('提供方')
    await pick.waitFor({ timeout: 10_000 })
    await pick.selectOption('minimax-cn')
    await expect.poll(
      async () => settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)

    const dismissed = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DISMISSED_EXPECTED, dismissed, MODE)

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stops prompting once the other provider can serve requests', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    await expect.poll(
      async () => page.getByRole('dialog', { name: CONFIGURE_STEP }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    await settings.getByText('minimax-cn', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await settings.getByText('DeepSeek', { exact: true }).count()).toBe(0)
    expect(await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(0)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['dismissed.expected.md'])
  })
})
