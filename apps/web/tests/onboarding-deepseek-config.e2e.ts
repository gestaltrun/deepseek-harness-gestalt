// Keyless browser e2e: first-run onboarding reminds the user to configure a
// model, opens Settings → Models, and does not mint official DeepSeek.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-deepseek-config', import.meta.url))
const WELCOME_EXPECTED = join(SNAPSHOT_DIR, 'welcome.expected.md')
const MISSING_EXPECTED = join(SNAPSHOT_DIR, 'missing.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const MODE = webSnapshotMode()
const CONFIGURE_STEP = '配置模型即可开始使用'

describe.skipIf(MODE === 'record')('web e2e: first-run configure-models onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, welcomeNoticePending: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', message => browserConsole.push(message.text()))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens Settings Models from onboarding and configures catalog deepseek', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-config'))
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    for (const paragraph of WELCOME_NOTICE_COPY.zh.body.split('\n\n')) {
      expect(await welcome.getByText(paragraph, { exact: true }).count()).toBe(1)
    }
    const welcomeAria = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WELCOME_EXPECTED, welcomeAria, MODE)

    const firstReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, firstReloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })

    const configureStep = page.getByRole('dialog', { name: CONFIGURE_STEP })
    await configureStep.waitFor({ timeout: 15_000 })
    expect(await configureStep.getByLabel('API 密钥', { exact: true }).count()).toBe(0)
    const initial = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MISSING_EXPECTED, initial, MODE)

    await configureStep.getByRole('button', { name: '去配置' }).click()
    await configureStep.waitFor({ state: 'detached', timeout: 15_000 })
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('heading', { name: '模型' }).waitFor({ timeout: 10_000 })
    expect(await settings.getByText('DeepSeek', { exact: true }).count()).toBe(0)

    const opened = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, opened, MODE)

    const add = settings.getByRole('button', { name: '添加提供方' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = settings.getByLabel('提供方')
    await pick.waitFor({ timeout: 10_000 })
    const values = await pick.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
    expect(values).toContain('deepseek')
    expect(values).not.toContain('deepseek-official')
    await pick.selectOption('minimax-cn')

    const secret = `dsh_onboarding_${randomBytes(12).toString('hex')}`
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).fill(secret)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })

    const stored = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(stored.includes(`MINIMAX_CN_API_KEY: ${secret}`)).toBe(true)
    expect((await page.content()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)

    const acknowledgedSettings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(acknowledgedSettings).toContain(`${WELCOME_NOTICE_ACK_FIELD}: ${WELCOME_NOTICE_VERSION}`)
    expect(acknowledgedSettings).toContain('minimax-cn:')
    expect(await settings.getByText('DeepSeek', { exact: true }).count()).toBe(0)

    const secondReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, secondReloadWarnings)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: CONFIGURE_STEP }).count()).toBe(0)

    await scaffold.ctx.settings.mutate(settingsNamespace(WELCOME_NOTICE_SETTINGS_NAMESPACE), [{
      op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: 'previous-copy-version',
    }])
    const thirdReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, thirdReloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })
    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: CONFIGURE_STEP }).count()).toBe(0)

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('never paints the takeover chrome on a configured reload, even with the settings join held open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-configured-reload'))
    await page.addInitScript(() => {
      const sightings: string[] = []
      ;(window as unknown as { __takeoverSightings: string[] }).__takeoverSightings = sightings
      setInterval(() => {
        if (document.querySelector(
          '[role="dialog"][aria-label="内测声明"], '
          + '[role="dialog"][aria-label="配置模型即可开始使用"]',
        ) !== null) {
          sightings.push('chrome')
        }
        if (document.getElementById('root')?.inert === true) sightings.push('inert')
      }, 8)
    })
    let released = false
    const heldRoutes: Array<() => void> = []
    const releaseDescribe = (): void => {
      released = true
      for (const resolve of heldRoutes.splice(0)) resolve()
    }
    await page.route('**/api/settings.describe', async (route) => {
      if (!released) await new Promise<void>((resolve) => { heldRoutes.push(resolve) })
      await route.continue()
    })
    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'commit' })
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    await page.waitForTimeout(600)
    releaseDescribe()
    await page.waitForTimeout(400)
    await page.unroute('**/api/settings.describe')
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    expect(await page.evaluate(() =>
      (window as unknown as { __takeoverSightings: string[] }).__takeoverSightings)).toEqual([])
    expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: CONFIGURE_STEP }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(
      SNAPSHOT_DIR,
      ['welcome.expected.md', 'missing.expected.md', 'models.expected.md'],
    )
  })
})
