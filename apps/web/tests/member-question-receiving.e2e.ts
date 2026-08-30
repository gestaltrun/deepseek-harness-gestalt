// Keyless assembled acceptance for the receiving half of a routed member
// question. The sender is a mock remote Agent only; the user-questions service,
// api-proxy pending registry, SSE mux, Client Runtime, dynamic module table,
// composite card, shared QuestionPresentation, and response POST are shipped
// production paths. No model call or replay fixture participates.
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Browser, Page, Request } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()

function mockRemoteAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function isForbiddenSessionRequest(request: Request): boolean {
  return /\/api\/session\.(?:create|history)$/.test(new URL(request.url()).pathname)
}

describe.skipIf(MODE === 'record')('web e2e: member-question receiving session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const clientErrors: string[] = []
  const questionFrames: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error') clientErrors.push(message.text())
    })
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        const text = String(payload)
        if (text.includes('question/requested')) questionFrames.push(text)
      })
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('receives, focuses material, and answers without creating or opening a Host session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-member-question-receiving'))
    const initialSessionIds = scaffold.ctx.sessions.list().map(session => session.id)
    const create = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'create')
    const history = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'history')
    const forbiddenRequests: string[] = []
    const onRequest = (request: Request): void => {
      if (isForbiddenSessionRequest(request)) forbiddenRequests.push(request.url())
    }
    page.on('request', onRequest)

    const sender = mockRemoteAgent('remote-agent-member-question-e2e')
    const detachSender = scaffold.ctx.agents.enter(sender, undefined)
    try {
      const asked = scaffold.ctx.userQuestions.ask({
        agent: sender,
        questions: [{
          id: 'release-channel',
          header: 'Choose a channel',
          question: 'Which release channel should carry the receiver preview?',
          detail: 'Use the brief and material before choosing.',
          options: [
            { label: 'Canary (Recommended)', description: 'Limits the first rollout.' },
            { label: 'Stable', description: 'Makes the preview broadly visible.' },
          ],
          intent: {
            kind: 'member-question',
            questionId: 'mq-web-e2e-1',
            originSessionId: 'remote-origin-session-1',
            toProjectMember: 'account:receiver',
            origin: {
              projectName: 'Project Atlas',
              originSessionTitle: 'Receiver launch decision',
              askerAccountId: 'account:alice',
              askerRole: 'owner',
              askerDisplayName: 'Alice',
              askerAvatarUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
            },
            background: 'The preview needs a reversible channel before the wider release.',
            references: [{
              path: 'docs/receiver-decision.md',
              reason: 'Lists the rollout constraints',
              content: '# Receiver decision\n\n**Canary** keeps the initial audience bounded.',
            }],
            expiresAt: Date.now() + 60_000,
          },
        }],
      })
      // If a later UI assertion fails, scaffold teardown rejects the still
      // pending sender promise; observe that cleanup edge without replacing
      // the original promise asserted below.
      void asked.catch(() => {})

      const receivingTitle = 'Project Atlas — Receiver launch decision'
      const row = page.locator('[role="treeitem"]', { hasText: receivingTitle })
      await expect.poll(async () => ({
        row: await row.count(),
        clientErrors,
        memberIntentFrames: questionFrames.filter(frame => frame.includes('member-question')).length,
      }), { timeout: 30_000 }).toEqual({ row: 1, clientErrors: [], memberIntentFrames: 1 })
      await expect.poll(() => row.getByText('Waiting for answer', { exact: true }).count()).toBe(1)
      await row.click()

      const card = page.locator('[data-question-key]').filter({
        has: page.locator('[data-member-presentation]'),
      })
      await card.waitFor({ timeout: 30_000 })
      await expect.poll(() => card.getByText('Remote', { exact: true }).count()).toBe(1)
      await expect.poll(() => card.getByText('Alice', { exact: true }).count()).toBe(1)
      await expect.poll(() => card.getByText('Owner', { exact: true }).count()).toBe(1)
      await expect.poll(() => card.getByText('Project Atlas', { exact: false }).count()).toBeGreaterThan(0)
      await expect.poll(() => card.locator('[data-member-presentation]').count()).toBe(1)
      await expect.poll(() => card.getByText('Canary', { exact: true }).count()).toBe(1)

      await card.getByRole('button', { name: /receiver-decision\.md/ }).click()
      const details = page.locator('[data-details-panel][aria-expanded="true"]')
      await details.waitFor({ timeout: 10_000 })
      await expect.poll(() => details.getByText('Receiver decision', { exact: true }).count()).toBe(1)
      await expect.poll(() => details.locator('strong').filter({ hasText: 'Canary' }).count()).toBe(1)
      await expect.poll(() => card.getByRole('button', { name: 'Remote · Alice' }).count()).toBe(1)
      await details.getByRole('button', { name: 'Close details' }).focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('[data-details-panel]').getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => card.getByText('Which release channel should carry the receiver preview?').count()).toBe(1)

      await card.getByRole('radio', { name: 'Canary' }).click()
      await card.getByRole('button', { name: 'Submit' }).click()
      await expect(asked).resolves.toEqual({
        answers: [{ id: 'release-channel', selected: ['Canary (Recommended)'] }],
      })
      await expect.poll(() => page.locator('[data-question-key]').count(), { timeout: 10_000 }).toBe(0)

      expect(scaffold.ctx.sessions.list().map(session => session.id)).toEqual(initialSessionIds)
      expect(create).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      expect(forbiddenRequests).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      expect(clientErrors).toEqual([])
      expect(questionFrames).toHaveLength(1)
    } finally {
      page.off('request', onRequest)
      detachSender()
      create.mockRestore()
      history.mockRestore()
    }
  }, 90_000)
})
