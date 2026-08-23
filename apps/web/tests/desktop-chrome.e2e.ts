import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
// Empty type imports carry the agents, presets, and tools Context merges.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DESKTOP_BRIDGE_FIXTURE = fileURLToPath(
  new URL('../../../packages/client/ui-desktop/tests/desktop-bridge-fixture.client.ts', import.meta.url),
)

const OVERLAY = fileURLToPath(new URL('../../desktop/cordis.patch.yml', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/desktop-chrome', import.meta.url))
const INACTIVE_EXPECTED = fileURLToPath(new URL('./snapshots/desktop-chrome/inactive.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

async function openDesktopPage(browser: Browser, baseUrl: string, platform: 'darwin' | 'win32'): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
  // Dynamic import keeps this host-plane spec from loading packages/client/*/src.
  const { installDesktopBridgeFixture } = await import(pathToFileURL(DESKTOP_BRIDGE_FIXTURE).href) as {
    installDesktopBridgeFixture: (platform: 'darwin' | 'win32') => void
  }
  await page.addInitScript(installDesktopBridgeFixture, platform)
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForSelector(`[data-desktop-chrome="${platform === 'darwin' ? 'mac' : 'win'}"]`, {
    timeout: 30_000,
  })
  return page
}

async function sessionSurfaceGeometry(page: Page): Promise<{
  inset: number
  paddingTop: number
  chrome: string | null
}> {
  return await page.locator('[data-phase="active"]').first().evaluate((surface) => {
    const frame = surface.closest('[style*="grid-template-columns"]')
    let center = surface.parentElement
    while (center !== null && center.parentElement !== frame) center = center.parentElement
    if (center === null || frame === null) throw new Error('assembled Session Surface geometry is unavailable')
    return {
      inset: Math.round(surface.getBoundingClientRect().top - frame.getBoundingClientRect().top),
      paddingTop: Number.parseFloat(getComputedStyle(center).paddingTop),
      chrome: frame.querySelector('[data-desktop-chrome]')?.getAttribute('data-desktop-chrome') ?? null,
    }
  })
}

describe('web e2e: Desktop Session Surface overlay', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let macPage: Page
  let winPage: Page

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, replayFixture: FIXTURE, paceMs: 5 })
    browser = await chromium.launch()
    macPage = await openDesktopPage(browser, scaffold.baseUrl, 'darwin')
    await connectFreshWorkspace(macPage, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = macPage.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
    await macPage.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await macPage.getByText('Standard mode', { exact: true }).waitFor({ timeout: 15_000 })

    winPage = await openDesktopPage(browser, scaffold.baseUrl, 'win32')
    await winPage.locator('[role="treeitem"]').filter({ hasText: 'Reply with the single word' }).first().click()
    await winPage.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await winPage.getByText('Standard mode', { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('composes the Gestalt brand and drag strip without an inactive updater control', async () => {
    expect(await macPage.locator('svg text', { hasText: 'GESTALT' }).count()).toBe(1)
    expect(await macPage.locator('[data-desktop-chrome="mac"]').count()).toBe(1)
    expect(await macPage.getByRole('button', { name: 'Updates disabled in development' }).count()).toBe(0)
    await compareOrRefreshGolden(INACTIVE_EXPECTED, await captureStableAria(
      macPage,
      '[class*="footArea"]',
      scaffold.workspaceCwd,
    ), MODE)
  })

  it('gives a fresh Desktop Session the Schedule tools', async () => {
    const ctx = scaffold.ctx
    const handle = await ctx.agents.create({
      sessionId: SessionId('desktop-schedule-default'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      expect(ctx.tools.schemas(handle.agent)
        .map(schema => schema.name)
        .filter(name => name.startsWith('schedule_'))
        .sort()).toEqual(['schedule_create', 'schedule_delete', 'schedule_list'])
    } finally {
      await handle.dispose()
    }
  })

  it('insets the active Session Surface below the Desktop drag strip', async () => {
    expect(await sessionSurfaceGeometry(macPage)).toEqual({
      inset: 36,
      paddingTop: 36,
      chrome: 'mac',
    })
    expect(await sessionSurfaceGeometry(winPage)).toEqual({
      inset: 36,
      paddingTop: 36,
      chrome: 'win',
    })
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['inactive.expected.md'])
  })
})
