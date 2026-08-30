// Keyless assembled acceptance: authenticated receiver ingress -> durable Host
// snapshot/change feed -> real HTTP/WebSocket Client Runtime -> composite card
// -> Host answer/decline RPC -> passive terminal record band. Arrival creates
// no Host Session and invokes no model path.
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  createAuthenticatedMemberQuestionIngress,
  type MemberQuestionReceiverService,
} from '@deepseek-ai/dsh-member-question-receiver'
import type { Browser, Page, Request } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()

function isForbiddenSessionRequest(request: Request): boolean {
  return /\/api\/session\.(?:create|history|prompt)$/.test(new URL(request.url()).pathname)
}

function operation(questionId: string, operationId: string) {
  return {
    type: 'member-question' as const,
    operationId: operationId as never,
    questionId: questionId as never,
    projectId: 'project-atlas' as never,
    originSessionId: 'remote-origin-session-1' as never,
    expiresAt: Date.now() + 60_000,
    origin: {
      projectName: 'Project Atlas',
      originSessionTitle: 'Receiver launch decision',
      askerAccountId: 'account:alice',
      askerRole: 'owner' as const,
      askerDisplayName: 'Alice',
      askerAvatarUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
    },
    background: 'The preview needs a reversible channel before the wider release.',
    questions: [{
      id: 'release-channel',
      header: 'Choose a channel',
      question: 'Which release channel should carry the receiver preview?',
      options: [
        { label: 'Canary (Recommended)', description: 'Limits the first rollout.' },
        { label: 'Stable', description: 'Makes the preview broadly visible.' },
      ],
    }],
    references: [{ path: 'docs/receiver-decision.md', reason: 'Lists the rollout constraints' }],
  }
}

describe.skipIf(MODE === 'record')('web e2e: Host-owned member-question receiving session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let receiver: MemberQuestionReceiverService
  let tripwire: ReturnType<typeof watchConsole>
  let harnessHome: string
  const forbiddenRequests: string[] = []

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-member-question-home-'))
    scaffold = await launchWebScaffold({ harnessHome })
    const service = scaffold.ctx.get('memberQuestionReceiver')
    if (service === undefined) throw new Error('member-question e2e: receiver unavailable')
    receiver = service
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      if (isForbiddenSessionRequest(request)) forbiddenRequests.push(request.url())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('answers and declines through Host authority while retaining terminal bands', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-member-question-host-receiver'))
    forbiddenRequests.length = 0
    const initialSessionIds = scaffold.ctx.sessions.list().map(session => session.id)
    const create = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'create')
    const history = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'history')
    const prompt = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'prompt')
    const ingress = createAuthenticatedMemberQuestionIngress(receiver)
    try {
      const first = await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-1', 'mq-web-operation-1'),
      })
      expect(first.receivingSessionId).not.toMatch(/^mq-recv:/u)

      const title = 'Project Atlas — Receiver launch decision'
      const row = page.locator('[role="treeitem"]', { hasText: title })
      await row.waitFor({ timeout: 30_000 })
      await row.click()
      const card = page.locator('[data-question-key]').filter({ has: page.locator('[data-member-presentation]') })
      await card.waitFor({ timeout: 30_000 })
      await card.getByRole('radio', { name: 'Canary' }).click()
      await card.getByRole('button', { name: 'Submit' }).click()

      await expect.poll(async () => (await receiver.snapshot()).terminal[0]?.terminal.outcome)
        .toBe('answered')
      await expect.poll(() => page.locator('[data-record-state="answered"]').count()).toBe(1)

      await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-2', 'mq-web-operation-2'),
      })
      const secondCard = page.locator('[data-question-key]').filter({ has: page.locator('[data-member-presentation]') })
      await secondCard.waitFor({ timeout: 30_000 })
      await secondCard.getByRole('button', { name: 'Dismiss all questions' }).click()
      await expect.poll(async () => (await receiver.snapshot()).terminal.at(-1)?.terminal.outcome)
        .toBe('declined')
      await expect.poll(() => page.locator('[data-record-state="declined"]').count()).toBe(1)

      const third = await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-3', 'mq-web-operation-3'),
      })
      expect(third.receivingSessionId).toBe(first.receivingSessionId)
      await expect.poll(() => page.locator('[data-question-key]').filter({
        has: page.locator('[data-member-presentation]'),
      }).count()).toBe(1)
      const beforeRestart = await receiver.snapshot()
      expect(beforeRestart.pending.map(row => row.questionId)).toEqual(['mq-web-host-3'])
      expect(beforeRestart.terminal.map(row => row.terminal.outcome)).toEqual(['answered', 'declined'])

      expect(scaffold.ctx.sessions.list().map(session => session.id)).toEqual(initialSessionIds)
      expect(create).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      expect(prompt).not.toHaveBeenCalled()
      expect(forbiddenRequests).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])

      await browser.close()
      await scaffold.close()

      scaffold = await launchWebScaffold({ harnessHome })
      const restartedService = scaffold.ctx.get('memberQuestionReceiver')
      if (restartedService === undefined) throw new Error('member-question e2e: restarted receiver unavailable')
      receiver = restartedService
      const restartedCreate = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'create')
      const restartedHistory = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'history')
      const restartedPrompt = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'prompt')
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      tripwire = watchConsole(page)
      forbiddenRequests.length = 0
      page.on('request', (request) => {
        if (isForbiddenSessionRequest(request)) forbiddenRequests.push(request.url())
      })
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

      const afterRestart = await receiver.snapshot()
      expect(afterRestart).toEqual(beforeRestart)
      const restartedRow = page.locator('[role="treeitem"]', { hasText: title })
      await restartedRow.waitFor({ timeout: 30_000 })
      await restartedRow.click()
      await expect.poll(() => page.locator('[data-question-key]').filter({
        has: page.locator('[data-member-presentation]'),
      }).count()).toBe(1)
      await expect.poll(() => page.locator('[data-record-state="answered"]').count()).toBe(1)
      await expect.poll(() => page.locator('[data-record-state="declined"]').count()).toBe(1)
      expect(scaffold.ctx.sessions.list()).toEqual([])
      expect(restartedCreate).not.toHaveBeenCalled()
      expect(restartedHistory).not.toHaveBeenCalled()
      expect(restartedPrompt).not.toHaveBeenCalled()
      expect(forbiddenRequests).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      restartedCreate.mockRestore()
      restartedHistory.mockRestore()
      restartedPrompt.mockRestore()
    } finally {
      create.mockRestore()
      history.mockRestore()
      prompt.mockRestore()
    }
  }, 90_000)
})
