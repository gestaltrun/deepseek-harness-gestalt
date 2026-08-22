// Keyless real-Web image-pin journeys: Composer staged pins (#57), history
// reattachment (#58), and mixed text-plus-image order with discard-all (#59).
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/annotation-images', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const MODEL_EXPECTED = join(SNAPSHOT_DIR, 'model-visible.expected.md')
const MODE = webSnapshotMode()
const PNG_NAME = 'pin-target.png'
const GIF_NAME = 'animated.gif'
const OPENING_PROMPT = 'Give one short sentence with one bold phrase about editing.'
const HISTORY_QUESTION = 'Look at this corner of the earlier image.'
const MIXED_QUESTION = 'Please make the passage more direct and look at this point.'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDKqHSTmKkroh7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHs8DAPH9/Q0aAAAAAElFTkSuQmCC',
  'base64',
)
const ANIMATED_GIF_BYTES = Buffer.from(
  'R0lGODlhCAAIAIAAAExpcf8AACH5BAUAAAAALAAAAAAIAAgAAAIHjI+py+1dAAAh+QQFAAAAACwAAAAACAAIAAACB4yPqcvtXQAAOw==',
  'base64',
)

function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
    ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
    : [])
}

function userImageBlocks(events: readonly SessionEvent[]): Array<{
  name?: string
  mediaType: string
  bytes: number
}> {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.data.content.flatMap((block) => {
      if (block.type !== 'image') return []
      return [{
        ...(block.attachment.name === undefined ? {} : { name: block.attachment.name }),
        mediaType: block.attachment.mediaType,
        bytes: block.attachment.bytes,
      }]
    })
    : [])
}

async function attachNamedFile(page: Page, name: string, mimeType: string, bytes: Buffer): Promise<void> {
  await page.evaluate(({ fileName, type, payload }) => {
    const binary = Uint8Array.from(atob(payload), char => char.charCodeAt(0))
    const file = new File([binary], fileName, { type })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { fileName: name, type: mimeType, payload: bytes.toString('base64') })
  await page.getByRole('group', { name: 'Pending images' }).getByAltText(name).waitFor({ timeout: 10_000 })
}

async function openPreview(page: Page, name: string): Promise<Locator> {
  const rail = page.getByRole('group', { name: 'Pending images' })
  await rail.getByAltText(name).click()
  const dialog = page.getByRole('dialog', { name: 'Original image preview' })
  await dialog.waitFor({ timeout: 10_000 })
  return dialog
}

async function previewImage(dialog: Locator, name: string): Promise<Locator> {
  const image = dialog.getByRole('img', { name })
  await image.waitFor({ timeout: 10_000 })
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth), { timeout: 5_000 })
    .toBeGreaterThan(0)
  return image
}

async function enterAnnotationMode(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Annotate image' }).click()
  await dialog.getByRole('button', { name: 'Exit annotation' }).waitFor({ timeout: 5_000 })
}

async function placePin(dialog: Locator, name: string, x = 0.25, y = 0.4): Promise<void> {
  const image = await previewImage(dialog, name)
  const box = await image.boundingBox()
  if (box === null || box.width < 8 || box.height < 8) {
    throw new Error(`expected a displayed lightbox image, got ${JSON.stringify(box)}`)
  }
  await image.click({ position: { x: box.width * x, y: box.height * y } })
}

async function savePinNote(page: Page, note?: string): Promise<void> {
  const editor = page.getByPlaceholder('Add an optional note').last()
  await editor.waitFor({ timeout: 10_000 })
  if (note !== undefined) await editor.fill(note)
  await editor.press('Enter')
}

async function selectPhrase(page: Page): Promise<void> {
  const target = page.locator('[data-annotation-source]').last()
  await target.evaluate((element) => {
    const strong = element.querySelector('strong')
    if (strong === null) throw new Error('expected bold Markdown text')
    const before = strong.previousSibling?.firstChild
    const after = strong.nextSibling?.firstChild
    if (before === null || before === undefined || after === null || after === undefined) {
      throw new Error('expected registered Markdown text leaves')
    }
    const range = document.createRange()
    range.setStart(before, 0)
    range.setEnd(after, 7)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

describe('web e2e: composer and history image annotation pins', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: OVERRIDE, paceMs: 5 })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('pins a Composer PNG, refuses an animated GIF, reattaches history, and mixes order', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-annotation-images'))
    const composer = page.locator('[data-composer-card] textarea').last()
    await composer.waitFor({ timeout: 10_000 })

    await attachNamedFile(page, PNG_NAME, 'image/png', PNG_BYTES)
    const preview = await openPreview(page, PNG_NAME)
    await (await previewImage(preview, PNG_NAME)).click()
    await expect(page.getByRole('button', { name: '1 annotation' }).count()).resolves.toBe(0)
    await enterAnnotationMode(preview)
    await expect(preview.getByRole('button', { name: 'Exit annotation' }).isVisible()).resolves.toBe(true)
    await placePin(preview, PNG_NAME)
    await savePinNote(page, 'this corner')
    await page.keyboard.press('Escape')
    const summary = page.getByRole('button', { name: '1 annotation' })
    await expect.poll(() => summary.count(), { timeout: 5_000 }).toBe(1)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(
      () => page.getByRole('group', { name: 'Pending images' }).getByAltText(PNG_NAME).count(),
      { timeout: 15_000 },
    ).toBe(1)
    await expect(page.getByRole('button', { name: '1 annotation' }).isVisible()).resolves.toBe(true)
    const restoredPreview = await openPreview(page, PNG_NAME)
    await expect(restoredPreview.getByRole('button', { name: 'Pin 1' }).isVisible()).resolves.toBe(true)
    const restoredBytes = await (await previewImage(restoredPreview, PNG_NAME)).evaluate(async (element) => {
      const response = await fetch((element as HTMLImageElement).src)
      return [...new Uint8Array(await response.arrayBuffer())]
    })
    expect(restoredBytes).toEqual([...PNG_BYTES])
    await page.keyboard.press('Escape')

    await attachNamedFile(page, GIF_NAME, 'image/gif', ANIMATED_GIF_BYTES)
    const gifPreview = await openPreview(page, GIF_NAME)
    await gifPreview.getByRole('button', { name: 'Annotate image' }).click()
    await expect.poll(
      () => gifPreview.getByRole('alert').count(),
      { timeout: 5_000 },
    ).toBe(1)
    await expect(gifPreview.getByRole('alert').textContent()).resolves.toBe('Animated GIFs cannot receive pins')
    await (await previewImage(gifPreview, GIF_NAME)).click()
    await expect(page.getByRole('button', { name: '1 annotation' }).isVisible()).resolves.toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: `Remove image ${GIF_NAME}` }).click()

    const firstSettled = scaffold.whenTurnSettled()
    await composer.fill(HISTORY_QUESTION)
    await composer.press('Enter')
    await firstSettled
    const firstCompiled = userTexts(events).at(-1)
    expect(firstCompiled).toContain(HISTORY_QUESTION)
    expect(firstCompiled).toMatch(/Annotation 1\nImage “pin-target\.png” at \d+\.\d%, \d+\.\d%/)
    expect(firstCompiled).toContain('Note: this corner')
    expect(userImageBlocks(events)).toEqual([
      { name: PNG_NAME, mediaType: 'image/png', bytes: PNG_BYTES.byteLength },
    ])
    await expect.poll(
      () => page.getByRole('button', { name: '1 annotation' }).count(),
      { timeout: 5_000 },
    ).toBe(0)

    const historyImage = page.getByRole('button', { name: `${PNG_NAME}, click to view original` }).last()
    await historyImage.waitFor({ timeout: 10_000 })
    await historyImage.click()
    const historyPreview = page.getByRole('dialog', { name: 'Original image preview' })
    await enterAnnotationMode(historyPreview)
    await placePin(historyPreview, PNG_NAME, 0.7, 0.3)
    await page.getByRole('button', { name: '1 annotation' }).waitFor({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    const historySettled = scaffold.whenTurnSettled()
    await composer.fill('Reattach the same image.')
    await composer.press('Enter')
    await historySettled
    expect(userTexts(events).at(-1)).toMatch(/Annotation 1\nImage “pin-target\.png” at \d+\.\d%, \d+\.\d%/)
    expect(userImageBlocks(events)).toEqual([
      { name: PNG_NAME, mediaType: 'image/png', bytes: PNG_BYTES.byteLength },
      { name: PNG_NAME, mediaType: 'image/png', bytes: PNG_BYTES.byteLength },
    ])

    const mixedOpening = scaffold.whenTurnSettled()
    await composer.fill(OPENING_PROMPT)
    await composer.press('Enter')
    await mixedOpening
    await page.getByText('exact phrase', { exact: true }).waitFor({ timeout: 10_000 })
    await attachNamedFile(page, PNG_NAME, 'image/png', PNG_BYTES)
    await selectPhrase(page)
    await page.getByRole('toolbar').getByRole('button', { name: 'Add annotation' }).click()
    await savePinNote(page, 'Keep the emphasis')
    const mixedPreview = await openPreview(page, PNG_NAME)
    await enterAnnotationMode(mixedPreview)
    await placePin(mixedPreview, PNG_NAME, 0.2, 0.8)
    await savePinNote(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '2 annotations' }).isVisible()).resolves.toBe(true)
    await page.getByRole('button', { name: 'Discard annotation draft' }).click()
    await expect.poll(
      () => page.getByRole('button', { name: '1 annotation' }).count(),
      { timeout: 5_000 },
    ).toBe(0)
    await expect.poll(
      () => page.getByRole('button', { name: '2 annotations' }).count(),
      { timeout: 5_000 },
    ).toBe(0)
    await selectPhrase(page)
    await page.getByRole('toolbar').getByRole('button', { name: 'Add annotation' }).click()
    await savePinNote(page, 'Keep the emphasis')
    const rebuiltPreview = await openPreview(page, PNG_NAME)
    await enterAnnotationMode(rebuiltPreview)
    await placePin(rebuiltPreview, PNG_NAME, 0.2, 0.8)
    await savePinNote(page)
    await page.keyboard.press('Escape')
    const mixedSettled = scaffold.whenTurnSettled()
    await composer.fill(MIXED_QUESTION)
    await composer.press('Enter')
    await mixedSettled
    const mixed = userTexts(events).at(-1) ?? ''
    expect(mixed.startsWith(MIXED_QUESTION)).toBe(true)
    expect(mixed).toContain('Quoted text: “The exact phrase should”')
    expect(mixed).toContain('Note: Keep the emphasis')
    expect(mixed).toMatch(/Annotation 2\nImage “pin-target\.png” at \d+\.\d%, \d+\.\d%/)
    await compareOrRefreshGolden(
      MODEL_EXPECTED,
      mixed.replace(/at \d+\.\d%, \d+\.\d%/, 'at {x}%, {y}%'),
      MODE,
    )
    await expect(page.getByRole('button', { name: '1 annotation' }).count()).resolves.toBe(0)
    await expect(page.getByRole('button', { name: '2 annotations' }).count()).resolves.toBe(0)
    // Unavailable-image send failure is not cheap here: the Host has no UI to
    // unlink a still-rendered history attachment, and deleting store objects
    // from the test process is not a user-visible assembled journey.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 240_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['model-visible.expected.md', 'replay.override.json'])
  })
})
