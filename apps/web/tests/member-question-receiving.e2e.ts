// Keyless assembled acceptance: authenticated receiver ingress -> durable Host
// snapshot/change feed -> real HTTP/WebSocket Client Runtime -> composite card
// -> Host answer/decline RPC -> exceptional terminal record band. Arrival
// materializes one Host Session in the invitation-bound Workspace and injects
// the Decision Brief without starting a model turn.
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  createAuthenticatedMemberQuestionIngress,
  type MemberQuestionReceiverService,
} from '@deepseek-ai/dsh-member-question-receiver'
import type { Browser, Locator, Page, Request } from 'playwright'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const SESSION_SELECTION_KEY = 'dsh.sessions.current'

function isForbiddenSessionRequest(request: Request): boolean {
  return /\/api\/session\.create$/.test(new URL(request.url()).pathname)
}

function operation(questionId: string, operationId: string, projectId: string) {
  return {
    type: 'member-question' as const,
    operationId: operationId as never,
    questionId: questionId as never,
    projectId: projectId as never,
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

function bindReceiverWorkspace(
  receiver: MemberQuestionReceiverService,
  projectId: string,
  workspaceId: Parameters<MemberQuestionReceiverService['bind']>[2],
): Promise<void> {
  return receiver.bind('account:receiver' as PlatformAccountId, projectId as never, workspaceId)
}

function sessionRow(page: Page, title: string) {
  return page.getByText(title, { exact: true }).locator('xpath=ancestor::*[@role="treeitem"][1]')
}

function sessionGroupHeader(row: Locator) {
  return row.locator('xpath=ancestor::div[contains(@class,"groupSection")][1]').getByRole('treeitem').first()
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
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(harnessHome, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'member-question e2e cleanup failed')
  })

  it('answers and declines through Host authority while retaining terminal bands', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-member-question-host-receiver'))
    forbiddenRequests.length = 0
    const initialSessionIds = scaffold.ctx.sessions.list().map(session => session.id)
    const receiverWorkspace = scaffold.ctx.workspaceRegistry.list()
      .find(candidate => candidate.path === join(scaffold.workspaceCwd, 'workspace'))
    if (receiverWorkspace === undefined) throw new Error('member-question e2e: connected workspace unavailable')
    await receiverWorkspace.setTitle('Atlas Bound Workspace')
    const projectId = 'project-atlas'
    await bindReceiverWorkspace(receiver, projectId, receiverWorkspace.id)
    const create = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'create')
    const prompt = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'prompt')
    const ingress = createAuthenticatedMemberQuestionIngress(receiver)
    try {
      const first = await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-1', 'mq-web-operation-1', projectId),
      })
      expect(first.receivingSessionId).not.toMatch(/^mq-recv:/u)

      const title = 'Project Atlas — Receiver launch decision'
      const row = sessionRow(page, title)
      await row.waitFor({ timeout: 30_000 })
      await expect.poll(() => sessionGroupHeader(row).textContent()).toContain('Atlas Bound Workspace')
      expect(await sessionGroupHeader(row).textContent()).not.toMatch(/Ungrouped/)
      expect(await page.getByText('Ungrouped', { exact: true }).count()).toBe(0)
      await row.click()
      await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
      const card = page.locator('[data-question-key]').filter({ has: page.locator('[data-member-presentation]') })
      await card.waitFor({ timeout: 30_000 })
      expect(scaffold.ctx.sessions.list().map(session => session.id))
        .toEqual([...initialSessionIds, first.receivingSessionId])
      expect(receiverWorkspace.sessionIds).toContain(first.receivingSessionId)
      expect(create).not.toHaveBeenCalled()
      expect(prompt).not.toHaveBeenCalled()
      expect(scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events
        .filter(event => event.type === 'request/header')).toHaveLength(0)
      const agentComposer = page.locator('[data-composer-card]')
      const composer = agentComposer.locator('textarea:enabled')
      await composer.fill('Help me evaluate the rollout tradeoffs before I answer.')
      await agentComposer.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events
        .filter(event => event.type === 'turn/start').length).toBe(1)
      await card.getByRole('radio', { name: 'Canary' }).click()
      await card.getByRole('button', { name: 'Submit' }).click()

      await expect.poll(async () => (await receiver.snapshot()).terminal[0]?.terminal.outcome)
        .toBe('answered')
      await expect.poll(() => page.locator('[data-record-state="answered"]').count()).toBe(0)
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events.filter(event =>
        event.type === 'member-question/settled'
        && event.data.questionId === 'mq-web-host-1'
        && event.data.outcome === 'answered').length).toBe(1)

      await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-2', 'mq-web-operation-2', projectId),
      })
      const secondCard = page.locator('[data-question-key]').filter({ has: page.locator('[data-member-presentation]') })
      await secondCard.waitFor({ timeout: 30_000 })
      await secondCard.getByRole('button', { name: 'Dismiss all questions' }).click()
      await expect.poll(async () => (await receiver.snapshot()).terminal.at(-1)?.terminal.outcome)
        .toBe('declined')
      await expect.poll(() => page.locator('[data-record-state="declined"]').count()).toBe(1)
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events.filter(event =>
        event.type === 'member-question/settled'
        && event.data.questionId === 'mq-web-host-2'
        && event.data.outcome === 'declined').length).toBe(1)

      const third = await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-3', 'mq-web-operation-3', projectId),
      })
      expect(third.receivingSessionId).toBe(first.receivingSessionId)
      await expect.poll(() => page.locator('[data-question-key]').filter({
        has: page.locator('[data-member-presentation]'),
      }).count()).toBe(1)
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events.filter(event =>
        event.type === 'member-question/received' && event.data.questionId === 'mq-web-host-3').length).toBe(1)
      const nextAgentComposer = page.locator('[data-composer-card]')
      await nextAgentComposer.locator('textarea:enabled').fill('Include the newly arrived rollback question too.')
      await nextAgentComposer.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events.filter(event =>
        event.type === 'user/message' && event.data.id === 'member-question-brief:mq-web-host-3').length).toBe(1)
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)?.events.filter(event =>
        event.type === 'turn/start').length).toBe(2)
      const beforeRestart = await receiver.snapshot()
      expect(beforeRestart.pending.map(row => row.questionId)).toEqual(['mq-web-host-3'])
      expect(beforeRestart.terminal.map(row => row.terminal.outcome)).toEqual(['answered', 'declined'])

      expect(scaffold.ctx.sessions.list().map(session => session.id))
        .toEqual([...initialSessionIds, first.receivingSessionId])
      expect(create).not.toHaveBeenCalled()
      expect(prompt).toHaveBeenCalled()
      expect(forbiddenRequests).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])

      const sessionBackup = join(harnessHome, 'session-backup')
      const storageBackup = join(harnessHome, 'storage-backup')
      const clientSelection = await page.evaluate(key => localStorage.getItem(key), SESSION_SELECTION_KEY)
      if (clientSelection === null) throw new Error('member-question e2e: client selection was not persisted')
      expect(JSON.parse(clientSelection) as unknown).toMatchObject({ sessionId: first.receivingSessionId })
      await browser.close()
      await scaffold.closeWithStateBackup({
        persistenceRoot: sessionBackup,
        storageRoot: storageBackup,
      })

      scaffold = await launchWebScaffold({
        harnessHome,
        persistenceSeed: sessionBackup,
        storageSeed: storageBackup,
      })
      const restartedService = scaffold.ctx.get('memberQuestionReceiver')
      if (restartedService === undefined) throw new Error('member-question e2e: restarted receiver unavailable')
      receiver = restartedService
      const restartedCreate = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'create')
      const restartedHistory = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'history')
      const restartedPrompt = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'prompt')
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      await page.addInitScript(({ key, value }) => { localStorage.setItem(key, value) }, {
        key: SESSION_SELECTION_KEY,
        value: clientSelection,
      })
      tripwire = watchConsole(page)
      forbiddenRequests.length = 0
      page.on('request', (request) => {
        if (isForbiddenSessionRequest(request)) forbiddenRequests.push(request.url())
      })
      const restartedWorkspace = scaffold.ctx.workspaceRegistry.get(receiverWorkspace.id)
      if (restartedWorkspace === undefined) throw new Error('member-question e2e: restarted workspace unavailable')
      expect(await receiver.lookup('account:receiver' as PlatformAccountId, projectId as never))
        .toBe(restartedWorkspace.id)

      const afterRestart = await receiver.snapshot()
      expect(afterRestart).toEqual(beforeRestart)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const restartedRow = sessionRow(page, title)
      await restartedRow.waitFor({ timeout: 30_000 })
      await restartedRow.click()
      await expect.poll(() => restartedRow.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => page.locator('[data-question-key]').filter({
        has: page.locator('[data-member-presentation]'),
      }).count()).toBe(1)
      await expect.poll(() => page.locator('[data-record-state="answered"]').count()).toBe(0)
      await expect.poll(() => page.locator('[data-record-state="declined"]').count()).toBe(1)
      const persistedSessions = await scaffold.ctx.sessionPersistence.list()
      expect(persistedSessions.map(session => session.id)).toContain(first.receivingSessionId)
      await expect.poll(() => scaffold.ctx.sessions.get(first.receivingSessionId as never)).toBeDefined()
      const restartedSession = scaffold.ctx.sessions.get(first.receivingSessionId as never)
      expect(restartedSession?.events.filter(event => event.type === 'member-question/settled'))
        .toHaveLength(2)
      expect(restartedCreate).not.toHaveBeenCalled()
      expect(new Set(restartedHistory.mock.calls.map(([request]) => request.payload.sessionId)))
        .toEqual(new Set([first.receivingSessionId]))
      expect(restartedPrompt).not.toHaveBeenCalled()
      expect(forbiddenRequests).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      restartedCreate.mockRestore()
      restartedHistory.mockRestore()
      restartedPrompt.mockRestore()
    } finally {
      create.mockRestore()
      prompt.mockRestore()
    }
  }, 90_000)

  it('recovers one reserved post-prompt admission across Host restart through the same wire rpcId', async () => {
    const restartHome = await mkdtemp(join(tmpdir(), 'dsh-web-member-question-reserved-restart-'))
    let restartScaffold = await launchWebScaffold({ harnessHome: restartHome })
    const workspacePath = join(restartScaffold.workspaceCwd, 'workspace')
    const backup = join(restartHome, 'reserved-session-backup')
    try {
      await mkdir(workspacePath, { recursive: true })
      let workspace = await restartScaffold.ctx.workspaceRegistry.create(workspacePath)
      let service = restartScaffold.ctx.get('memberQuestionReceiver')
      if (service === undefined) throw new Error('member-question restart e2e: receiver unavailable')
      await bindReceiverWorkspace(service, 'project-host-restart', workspace.id)
      const arrived = await createAuthenticatedMemberQuestionIngress(service)({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-host-restart', 'mq-operation-host-restart', 'project-host-restart'),
      })
      const rpcId = 'rpc-post-prompt-host-restart'
      const payload = {
        receivingSessionId: arrived.receivingSessionId,
        revision: arrived.revision,
        content: [
          { type: 'text' as const, text: 'Recover this reserved human turn.' },
          { type: 'image' as const, mediaType: 'image/png' as const, data: PNG_1X1, name: 'decision.png' },
        ],
        mode: 'queue' as const,
      }
      const realFlush = restartScaffold.ctx.sessions.flush.bind(restartScaffold.ctx.sessions)
      vi.spyOn(restartScaffold.ctx.sessions, 'flush')
        .mockImplementationOnce(realFlush)
        .mockRejectedValueOnce(new Error('injected post-prompt restart failure'))
      const failed = await restartScaffold.ctx.apiProxy.memberQuestions.admitHumanTurn({
        rpcId: rpcId as never,
        payload,
      })
      expect(failed.result).toMatchObject({ ok: false })
      expect((await service.snapshot()).pending[0]?.reservedAdmission?.rpcId).toBe(rpcId)
      const ledger = await readFile(join(
        restartHome,
        'member-question-receiver',
        'development',
        'member-question-receiver.json',
      ), 'utf8')
      expect(ledger).not.toContain(PNG_1X1)
      expect(ledger).toContain('"attachmentId"')
      await cp(restartScaffold.persistenceRoot, backup, { recursive: true })
      vi.restoreAllMocks()
      await restartScaffold.close()

      restartScaffold = await launchWebScaffold({ harnessHome: restartHome, persistenceSeed: backup })
      await mkdir(workspacePath, { recursive: true })
      workspace = await restartScaffold.ctx.workspaceRegistry.create(workspacePath)
      service = restartScaffold.ctx.get('memberQuestionReceiver')
      if (service === undefined) throw new Error('member-question restart e2e: restarted receiver unavailable')
      await bindReceiverWorkspace(service, 'project-host-restart', workspace.id)
      expect((await service.snapshot()).pending[0]?.reservedAdmission?.rpcId).toBe(rpcId)
      const recovered = await restartScaffold.ctx.apiProxy.memberQuestions.admitHumanTurn({
        rpcId: rpcId as never,
        payload,
      })
      expect(recovered.result).toMatchObject({ ok: true })
      const session = restartScaffold.ctx.sessions.get(arrived.receivingSessionId as never)
      expect(session?.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(session?.events.filter(event => event.type === 'user/message'
        ? event.data.id === `member-question-human:${rpcId}`
        : event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === `member-question-human:${rpcId}`))).toHaveLength(1)
      const humanContent = session?.events.flatMap((event) => {
        if (event.type === 'user/message' && event.data.id === `member-question-human:${rpcId}`) {
          return [event.data.content]
        }
        if (event.type !== 'agent/inbox/spliced') return []
        const message = event.data.inserted.find(row => row.id === `member-question-human:${rpcId}`)
        return message === undefined ? [] : [message.content]
      })[0]
      expect(humanContent?.some(block => block.type === 'image'
        && block.attachment.mediaType === 'image/png')).toBe(true)
    } finally {
      vi.restoreAllMocks()
      await restartScaffold.close()
      await rm(restartHome, { recursive: true, force: true })
    }
  }, 90_000)

  it('retries an ordinary Host prompt after a lost response on the materialized Session', async () => {
    const faultHome = await mkdtemp(join(tmpdir(), 'dsh-web-member-question-lost-response-'))
    const faultScaffold = await launchWebScaffold({ harnessHome: faultHome })
    const faultBrowser = await chromium.launch()
    const faultPage = await newEnglishPage(faultBrowser)
    try {
      await faultPage.goto(faultScaffold.baseUrl, { waitUntil: 'load' })
      await faultPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(faultPage, faultScaffold.workspaceCwd)
      const workspace = faultScaffold.ctx.workspaceRegistry.list()
        .find(candidate => candidate.path === join(faultScaffold.workspaceCwd, 'workspace'))
      if (workspace === undefined) throw new Error('member-question lost-response e2e: workspace unavailable')
      const service = faultScaffold.ctx.get('memberQuestionReceiver')
      if (service === undefined) throw new Error('member-question lost-response e2e: receiver unavailable')
      await bindReceiverWorkspace(service, 'project-lost-response', workspace.id)
      const arrived = await createAuthenticatedMemberQuestionIngress(service)({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-lost-response', 'mq-operation-lost-response', 'project-lost-response'),
      })
      const faultRow = sessionRow(faultPage, 'Project Atlas — Receiver launch decision')
      await faultRow.click()
      await expect.poll(() => faultRow.getAttribute('aria-selected')).toBe('true')
      const promptRpcIds: string[] = []
      faultPage.on('request', (request) => {
        if (!new URL(request.url()).pathname.endsWith('/api/session.prompt')) return
        promptRpcIds.push((request.postDataJSON() as { rpcId: string }).rpcId)
      })
      const realFlush = faultScaffold.ctx.sessions.flush.bind(faultScaffold.ctx.sessions)
      vi.spyOn(faultScaffold.ctx.sessions, 'flush')
        .mockImplementationOnce(realFlush)
        .mockRejectedValueOnce(new Error('response lost after Host admission'))
      const composer = faultPage.locator('[data-composer-card] textarea:enabled')
      const text = 'Retain this exact human action across the lost response.'
      await composer.fill(text)
      await faultPage.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => promptRpcIds.length).toBe(1)
      await composer.fill(text)
      await faultPage.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => promptRpcIds.length).toBe(2)
      expect(promptRpcIds.length).toBeGreaterThan(0)
      await expect.poll(() => faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)?.events
        .filter(event => event.type === 'turn/start').length).toBeGreaterThan(0)
      await expect.poll(() => faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)?.events.filter(event =>
        event.type === 'user/message' && event.data.content.some(block =>
          block.type === 'text' && block.text === text)).length).toBeGreaterThan(0)
    } finally {
      await faultBrowser.close()
      await faultScaffold.close()
      await rm(faultHome, { recursive: true, force: true })
    }
  }, 90_000)

  it('retries terminal persistence and drains the owned retry before Host disposal', async () => {
    const faultHome = await mkdtemp(join(tmpdir(), 'dsh-web-member-question-terminal-retry-'))
    const faultScaffold = await launchWebScaffold({ harnessHome: faultHome })
    let closeStarted = false
    try {
      const faultReceiver = faultScaffold.ctx.get('memberQuestionReceiver')
      if (faultReceiver === undefined) throw new Error('member-question terminal retry e2e: receiver unavailable')
      const workspacePath = join(faultScaffold.workspaceCwd, 'workspace')
      await mkdir(workspacePath, { recursive: true })
      const workspace = await faultScaffold.ctx.workspaceRegistry.create(workspacePath)
      await bindReceiverWorkspace(faultReceiver, 'project-terminal-retry', workspace.id)
      const arrived = await createAuthenticatedMemberQuestionIngress(faultReceiver)({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation('mq-web-terminal-retry', 'mq-operation-terminal-retry', 'project-terminal-retry'),
      })
      expect(faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)).toBeDefined()

      let releaseRetry!: () => void
      const retryGate = new Promise<boolean>((resolve) => { releaseRetry = () => { resolve(true) } })
      const realFlush = faultScaffold.ctx.sessions.flush.bind(faultScaffold.ctx.sessions)
      let terminalAttempts = 0
      vi.spyOn(faultScaffold.ctx.sessions, 'flush').mockImplementation((session) => {
        const terminal = session.events.some(event => event.type === 'member-question/settled'
          && event.data.questionId === arrived.questionId)
        if (!terminal) return realFlush(session)
        terminalAttempts += 1
        if (terminalAttempts === 1) return Promise.reject(new Error('injected terminal persistence failure'))
        if (terminalAttempts === 2) return retryGate
        return realFlush(session)
      })
      await faultReceiver.settle(arrived.questionId, {
        kind: 'declined',
        settledByInstallationId: 'receiver-installation' as never,
        settledByDeviceName: 'Receiver Desktop',
        settledAt: Date.now(),
      })
      await expect.poll(() => terminalAttempts, { timeout: 5_000 }).toBe(2)
      expect(faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)?.events.filter(event =>
        event.type === 'member-question/settled'
        && event.data.questionId === arrived.questionId)).toHaveLength(1)

      let closed = false
      const closing = faultScaffold.close().then(() => { closed = true })
      closeStarted = true
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(closed).toBe(false)
      releaseRetry()
      await closing
      expect(closed).toBe(true)
    } finally {
      vi.restoreAllMocks()
      if (!closeStarted) await faultScaffold.close()
      await rm(faultHome, { recursive: true, force: true })
    }
  }, 90_000)

  it.each([
    'post-create',
    'post-record',
    'post-prompt',
  ] as const)('retries a %s Host admission failure without duplicating the Session or turn', async (stage) => {
    const faultHome = await mkdtemp(join(tmpdir(), `dsh-web-member-question-${stage}-`))
    const faultScaffold = await launchWebScaffold({ harnessHome: faultHome })
    try {
      const faultReceiver = faultScaffold.ctx.get('memberQuestionReceiver')
      if (faultReceiver === undefined) throw new Error('member-question fault e2e: receiver unavailable')
      const workspacePath = join(faultScaffold.workspaceCwd, 'workspace')
      await mkdir(workspacePath, { recursive: true })
      const workspace = await faultScaffold.ctx.workspaceRegistry.create(workspacePath)
      await bindReceiverWorkspace(faultReceiver, `project-${stage}`, workspace.id)
      const ingress = createAuthenticatedMemberQuestionIngress(faultReceiver)
      const arrived = await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: operation(`mq-web-${stage}`, `mq-operation-${stage}`, `project-${stage}`),
      })
      const request = {
        receivingSessionId: arrived.receivingSessionId,
        revision: arrived.revision,
        rpcId: `rpc-${stage}` as never,
        content: [{ type: 'text' as const, text: `Human prompt after ${stage}.` }],
        mode: 'queue' as const,
      }

      if (stage === 'post-create') {
        vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('injected post-create failure'))
      } else {
        const realFlush = faultScaffold.ctx.sessions.flush.bind(faultScaffold.ctx.sessions)
        const flush = vi.spyOn(faultScaffold.ctx.sessions, 'flush')
        if (stage === 'post-record') {
          flush.mockRejectedValueOnce(new Error('injected post-record failure'))
        } else {
          flush.mockImplementationOnce(realFlush)
          flush.mockRejectedValueOnce(new Error('injected post-prompt failure'))
        }
      }

      await expect(faultReceiver.admitHumanTurn(request)).rejects.toThrow(`injected ${stage} failure`)
      vi.restoreAllMocks()
      await expect(faultReceiver.admitHumanTurn(request)).resolves.toMatchObject({ accepted: true })
      await expect.poll(() => faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)?.events
        .filter(event => event.type === 'turn/start').length).toBe(1)
      await expect.poll(() => faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)?.events
        .filter(event => event.type === 'user/message'
          ? event.data.id === `member-question-human:rpc-${stage}`
          : event.type === 'agent/inbox/spliced'
            && event.data.inserted.some(message => message.id === `member-question-human:rpc-${stage}`)).length)
        .toBe(1)

      const materialized = faultScaffold.ctx.sessions.get(arrived.receivingSessionId as never)
      expect(materialized).toBeDefined()
      expect(faultScaffold.ctx.sessions.list()
        .filter(session => String(session.id) === String(arrived.receivingSessionId))).toHaveLength(1)
      expect(materialized?.events.filter(event => event.type === 'member-question/received'
        && event.data.questionId === `mq-web-${stage}`)).toHaveLength(1)
      expect(materialized?.events.filter(event => event.type === 'user/message'
        ? event.data.id === `member-question-human:rpc-${stage}`
        : event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === `member-question-human:rpc-${stage}`)))
        .toHaveLength(1)
    } finally {
      vi.restoreAllMocks()
      await faultScaffold.close()
      await rm(faultHome, { recursive: true, force: true })
    }
  }, 90_000)
})
