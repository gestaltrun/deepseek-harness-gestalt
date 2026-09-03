/** Black-box helpers for the built Desktop Host phone-tab journey. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browser, expect } from '@wdio/globals'
import type {} from '@wdio/native-types'
import { readOwnedFakeProcess } from '../../scripts/e2e-electron-runner-support.mjs'

interface FakeIoRecord {
  readonly method?: string
  readonly params?: { readonly deviceId?: string; readonly x?: number; readonly y?: number; readonly button?: string }
}

export interface FakeCounters {
  readonly requests: number
  readonly io: readonly FakeIoRecord[]
  readonly captures: ReadonlyArray<{ readonly deviceId: string; readonly format: string }>
}

interface StartupEvidence {
  readonly origin: string
  readonly hostPid: number
  readonly entryStatus: number
  readonly rendererUrl: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function newSessionButton() {
  return browser.$('button=新会话')
}

function newTabButton() {
  return browser.$('button[aria-label="新建标签页"], button[aria-label="New tab"]')
}

async function visibleNewTabButton() {
  const buttons = await browser.$$('button[aria-label="新建标签页"], button[aria-label="New tab"]').getElements()
  for (const button of buttons) {
    if (await button.isDisplayed()) return button
  }
  throw new Error('the expanded right sidebar exposed no visible + control')
}

/** Focus the Session Surface rather than the Desktop overlay document. */
export async function switchToSessionSurface(): Promise<void> {
  const handles = await browser.getWindowHandles()
  for (const handle of handles) {
    await browser.switchToWindow(handle)
    const overlay = await browser.execute(() => document.documentElement.hasAttribute('data-dsh-desktop-overlay'))
    if (!overlay) return
  }
  throw new Error('Desktop Host exposed no Session Surface window')
}

/** Focus the Desktop overlay WebContentsView exposed as a WebDriver window. */
export async function switchToDesktopOverlay(): Promise<void> {
  const handles = await browser.getWindowHandles()
  for (const handle of handles) {
    await browser.switchToWindow(handle)
    const overlay = await browser.execute(() => document.documentElement.hasAttribute('data-dsh-desktop-overlay'))
    if (overlay) return
  }
  throw new Error('Desktop Host exposed no overlay WebContentsView')
}

/** Require URL announcement, same-origin entry 200, renderer boot, and a settle interval. */
export async function assertStartupEvidence(): Promise<StartupEvidence> {
  const smokeFile = requiredEnv('DSH_DESKTOP_SMOKE_FILE')
  let text = ''
  let match: RegExpMatchArray | null = null
  await browser.waitUntil(async () => {
    text = await readFile(smokeFile, 'utf8').catch(() => '')
    if (/^error /m.test(text)) throw new Error(`Desktop Host smoke log contains an error:\n${text}`)
    match = text.match(/^host (http:\/\/127\.0\.0\.1:\d+) pid (\d+)$/m)
    return match !== null
  }, { timeout: 120_000, timeoutMsg: 'Desktop Host did not announce a Web Host URL' })
  const origin = match?.[1]
  const hostPid = Number(match?.[2])
  if (origin === undefined || !Number.isSafeInteger(hostPid)) throw new Error(`invalid host announcement:\n${text}`)
  const entry = await fetch(origin)
  if (entry.status !== 200) throw new Error(`Desktop Web Host entry answered HTTP ${String(entry.status)}`)
  await switchToSessionSurface()
  await browser.waitUntil(async () => {
    return await browser.execute(() => typeof (window as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ === 'object')
      || await newSessionButton().isExisting()
  }, { timeout: 120_000, timeoutMsg: 'Desktop Session Surface did not render' })
  const rendererUrl = await browser.getUrl()
  expect(new URL(rendererUrl).origin).toBe(origin)
  await browser.pause(1_000)
  const settledText = await readFile(smokeFile, 'utf8')
  if (/^error /m.test(settledText)) throw new Error(`Desktop Host logged an error after settle:\n${settledText}`)
  const evidence = { origin, hostPid, entryStatus: entry.status, rendererUrl }
  await writeArtifact('startup.json', evidence)
  return evidence
}

/** Create a Workspace-backed Session so the Workbench tab strip exists. */
export async function openSession(): Promise<void> {
  await switchToSessionSurface()
  const welcome = browser.$('button=继续')
  if (await welcome.isExisting()) await welcome.click()
  const workspace = requiredEnv('DSH_ELECTRON_E2E_WORKSPACE')
  const created = await browser.execute(async (path: string) => {
    const call = async (method: string, payload: unknown): Promise<unknown> => {
      const response = await fetch(`${location.origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload,
        }),
      })
      const body = await response.json() as {
        result?: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
      }
      if (!response.ok || body.result === undefined || !body.result.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(body)}`)
      }
      return body.result.value
    }
    const workspaceValue = await call('workspace.create', { path }) as {
      workspace?: { workspaceId?: string }
    }
    const workspaceId = workspaceValue.workspace?.workspaceId
    if (typeof workspaceId !== 'string') throw new Error(`workspace.create omitted workspaceId: ${JSON.stringify(workspaceValue)}`)
    const sessionValue = await call('session.create', { workspaceId }) as { sessionId?: string }
    if (typeof sessionValue.sessionId !== 'string') throw new Error(`session.create omitted sessionId: ${JSON.stringify(sessionValue)}`)
    return { workspaceId, sessionId: sessionValue.sessionId }
  }, workspace)
  await writeArtifact('session.json', created)
  await browser.refresh()
  await newTabButton().waitForExist({ timeout: 30_000 })
}

/** Choose the singleton phone tab through the Desktop overlay + menu. */
export async function openPhoneTabFromPlusMenu(): Promise<void> {
  await switchToSessionSurface()
  const expand = browser.$('button[aria-label="展开侧边栏"], button[aria-label="Expand sidebar"]')
  if (await expand.isDisplayed()) await expand.click()
  await browser.$('button[aria-label="折叠侧边栏"], button[aria-label="Collapse sidebar"]')
    .waitForDisplayed({ timeout: 20_000 })
  const plus = await visibleNewTabButton()
  await plus.waitForClickable({ timeout: 20_000 })
  await plus.click()
  await switchToDesktopOverlay()
  const phoneItem = browser.$('//*[@role="menuitem" and contains(., "手机")]')
  await phoneItem.waitForDisplayed({ timeout: 20_000 })
  await phoneItem.click()
  await switchToSessionSurface()
}

/** Open the top-level Phone Devices settings section in the Desktop overlay. */
export async function assertPhoneDevicesSettingsSection(): Promise<void> {
  await switchToSessionSurface()
  const trigger = browser.$('button[aria-haspopup="dialog"]')
  await trigger.waitForClickable({ timeout: 20_000 })
  await trigger.click()
  await switchToDesktopOverlay()
  const phoneDevices = browser.$('//button[contains(., "手机设备") or contains(., "Phone Devices")]')
  await phoneDevices.waitForDisplayed({ timeout: 20_000 })
  await phoneDevices.click()
  await browser.$('[data-phone-settings]').waitForDisplayed({
    timeout: 20_000,
    timeoutMsg: 'Phone Devices settings body did not render',
  })
  await writeArtifact('phone-devices-settings.json', await browser.execute(() => ({
    url: location.href,
    text: document.body.innerText,
  })))
}

/** Read fakemobilecli counters through its external test endpoint. */
export async function fakeCounters(): Promise<FakeCounters> {
  const response = await fetch(`http://127.0.0.1:${requiredEnv('DSH_ELECTRON_E2E_FAKE_PORT')}/__test/counters`)
  const record = await response.json() as Partial<FakeCounters>
  if (typeof record.requests !== 'number' || !Number.isSafeInteger(record.requests)
    || !Array.isArray(record.io) || !Array.isArray(record.captures)) {
    throw new Error(`invalid fakemobilecli counters: ${JSON.stringify(record)}`)
  }
  return { requests: record.requests, io: record.io, captures: record.captures }
}

/** Wait until the external fake records the requested state. */
export async function waitForFakeIo(match: (counters: FakeCounters) => boolean): Promise<FakeCounters> {
  let last: FakeCounters = { requests: 0, io: [], captures: [] }
  await browser.waitUntil(async () => {
    last = await fakeCounters()
    return match(last)
  }, { timeout: 20_000, interval: 200, timeoutMsg: 'fakemobilecli did not record the expected io' })
  return last
}

/** Persist the Electron/Web Host/fakemobilecli PIDs for post-run cleanup verification. */
export async function recordOwnedProcesses(hostPid: number, includeFake: boolean): Promise<void> {
  const electronPid = await browser.electron.execute(() => process.pid)
  let fakePid: number | undefined
  if (includeFake) {
    const record = await readOwnedFakeProcess(
      Number(requiredEnv('DSH_ELECTRON_E2E_FAKE_PORT')),
      requiredEnv('DSH_ELECTRON_E2E_FAKE_OWNER'),
    )
    fakePid = record.pid
  }
  await writeArtifact('owned-processes.json', { electronPid, hostPid, ...(fakePid === undefined ? {} : { fakePid }) })
}

/** Save the current full Session Surface viewport as review evidence. */
export async function saveWindowEvidence(name: string): Promise<void> {
  await switchToSessionSurface()
  await browser.saveScreenshot(join(requiredEnv('DSH_ELECTRON_E2E_ARTIFACT_DIR'), `${name}.png`))
}

/** Count draggable phone tabs and return their visible titles. */
export async function phoneTabTitles(): Promise<string[]> {
  return await browser.execute(() => [...document.querySelectorAll<HTMLElement>('[draggable="true"][title^="手机"]')]
    .map(element => element.title))
}

/** Click one visible Session Surface button by exact text or aria-label. */
export async function clickSurfaceButton(name: string): Promise<void> {
  const clicked = await browser.execute((label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => (
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label
    ) && !element.disabled && element.getClientRects().length > 0)
    if (button === undefined) return false
    button.click()
    return true
  }, name)
  if (!clicked) throw new Error(`Session Surface has no visible ${name} button`)
}

export async function writeArtifact(name: string, value: unknown): Promise<void> {
  await writeFile(join(requiredEnv('DSH_ELECTRON_E2E_ARTIFACT_DIR'), name), JSON.stringify(value, undefined, 2) + '\n')
}
