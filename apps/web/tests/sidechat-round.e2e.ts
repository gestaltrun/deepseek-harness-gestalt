import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/sidechat-round', import.meta.url))
const EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const SIDE_BOUNDARY_PREFIX = 'Side conversation boundary'
const RESPONSE = 'Event sourcing is a pattern where all changes to an application\'s state are stored as an immutable, append-only sequence of events, rather than persisting only the current state, enabling full auditability, temporal queries, and event-driven architectures.'

describe.skipIf(MODE === 'record')('web e2e: Side Chat through the shipped workbench', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayChildFixtures: [FIXTURE],
      paceMs: 25,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 800)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('logs inherited context separately, settles the child, and renders its transcript', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidechat-round'))
    const parentSettled = scaffold.whenTurnSettled()
    const composer = page.locator('textarea:enabled').first()
    await composer.fill(PROMPT)
    await composer.press('Enter')
    const parentId = await parentSettled
    const liveIdsBeforeSideChat = scaffold.ctx.agents.list().map(agent => agent.id)

    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    const menuLabels = await page.getByRole('menuitem').allTextContents()
    expect(menuLabels).toContain('Side Chat')
    const menuItem = page.getByRole('menuitem', { name: 'Side Chat', exact: true })
    expect(await menuItem.locator('svg').count()).toBe(1)
    await menuItem.click()
    const panel = page.locator('[data-dsh-panel]:visible')
    const sideComposer = panel.locator('textarea:enabled')
    await sideComposer.waitFor({ timeout: 15_000 })
    expect(scaffold.ctx.agents.list().map(agent => agent.id)).toEqual(liveIdsBeforeSideChat)
    const selectSideModel = async () => {
      const trigger = panel.getByRole('button', { name: /^Select model, current DeepSeek-V4-Flash$/u })
      await trigger.waitFor({ timeout: 15_000 })
      await trigger.click()
      await panel.getByRole('menuitem', { name: /^Model/u }).click()
      const option = page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true })
      await option.waitFor({ timeout: 15_000 })
      await option.click()
      expect(await panel.getByText(/^Model operation failed:/u).count()).toBe(0)
    }
    await selectSideModel()
    expect(scaffold.ctx.agents.list().map(agent => agent.id)).toEqual(liveIdsBeforeSideChat)

    const childSettled = scaffold.whenTurnSettled()
    await sideComposer.fill(PROMPT)
    await sideComposer.press('Enter')
    const childId = await childSettled
    expect(childId).not.toBe(parentId)

    await panel.getByText(RESPONSE, { exact: true }).waitFor({ timeout: 30_000 })
    await selectSideModel()
    const selected = await page.request.post(`${scaffold.baseUrl}/sidebar/api/sidechat.selectModel`, {
      data: {
        childId,
        selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    })
    expect(selected.ok()).toBe(true)
    const child = scaffold.ctx.agents.get(childId)
    expect(child).toBeDefined()
    const injection = child?.session.events.find((event: SessionEvent) => {
      if (event.type !== 'user/message') return false
      const first = event.data.content[0]
      return first?.type === 'text' && first.text.startsWith(SIDE_BOUNDARY_PREFIX)
    })
    expect(injection?.type).toBe('user/message')
    if (injection?.type !== 'user/message') throw new Error('Side Chat boundary injection was not logged')
    const boundary = injection.data.content[0]
    expect(boundary?.type).toBe('text')
    if (boundary?.type !== 'text') throw new Error('Side Chat boundary injection was not text')
    expect(boundary.text).toMatch(new RegExp(`^${SIDE_BOUNDARY_PREFIX}`))
    expect(injection.data.source).toEqual(expect.objectContaining({
      kind: 'plugin',
      plugin: 'dsh-better-sidebar',
    }))

    await compareOrRefreshGolden(
      EXPECTED,
      await captureStableAria(page, '[data-dsh-panel]', scaffold.workspaceCwd),
      MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
