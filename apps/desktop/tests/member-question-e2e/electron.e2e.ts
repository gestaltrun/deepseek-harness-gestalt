/** Visible three-installation Electron acceptance for Project Members. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browser, expect } from '@wdio/globals'
import type {} from '@wdio/native-types'

type InstallationName = 'a1' | 'b1' | 'b2'

interface InstallationEvidence {
  electronPid: number
  hostPid: number
  hostOrigin: string
  rendererUrl: string
  dshHome: string
  userData: string
  workspace: string
  installationId: string
  accountId: string
}

interface DeliveryContext {
  readonly askerAccountId: string
  readonly receiverAccountId: string
  readonly projectId: string
}

type ControlAskStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'settled'; readonly outcome: 'answered' | 'declined' }
  | { readonly state: 'failed'; readonly code: string }

const installations: InstallationName[] = ['a1', 'b1', 'b2']
const evidence: Partial<Record<InstallationName, InstallationEvidence>> = {}
const workspaceIds: Partial<Record<InstallationName, string>> = {}
let deliveryContext: DeliveryContext | undefined

describe('Project Members three-installation Electron journey', () => {
  it('boots A1, B1, and B2 from isolated profiles at the exact built source', async () => {
    for (const name of installations) {
      const instance = getInstance(name)
      const smokeFile = required(`DSH_PROJECT_MEMBERS_${name.toUpperCase()}_SMOKE_FILE`)
      let text = ''
      await instance.waitUntil(async () => {
        text = await readFile(smokeFile, 'utf8').catch(() => '')
        if (/^error /m.test(text)) throw new Error(`${name} smoke failure:\n${text}`)
        return /^host http:\/\/127\.0\.0\.1:\d+ pid \d+$/m.test(text)
      }, { timeout: 180_000, timeoutMsg: `${name} did not announce its Web Host` })
      const host = text.match(/^host (http:\/\/127\.0\.0\.1:\d+) pid (\d+)$/m)
      if (host?.[1] === undefined || host[2] === undefined) throw new Error(`${name} host evidence is malformed`)
      await switchToSessionSurface(instance)
      await instance.waitUntil(async () => await instance.execute(() => (
        typeof (window as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ === 'object'
      )), { timeout: 180_000, timeoutMsg: `${name} renderer did not boot` })
      const electronPid = await instance.electron.execute(() => process.pid)
      evidence[name] = {
        electronPid,
        hostPid: Number(host[2]),
        hostOrigin: host[1],
        rendererUrl: await instance.getUrl(),
        dshHome: required(`DSH_PROJECT_MEMBERS_${name.toUpperCase()}_DSH_HOME`),
        userData: required(`DSH_PROJECT_MEMBERS_${name.toUpperCase()}_USER_DATA`),
        workspace: required(`DSH_PROJECT_MEMBERS_${name.toUpperCase()}_WORKSPACE`),
        installationId: `installation-${name}`,
        accountId: name === 'a1' ? 'account-a' : 'account-b',
      }
      await instance.saveScreenshot(join(
        required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name, 'boot.png',
      ))
    }
    const pids = Object.values(evidence).map(value => value.electronPid)
    expect(new Set(pids).size).toBe(3)
    await writeFile(
      join(required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), 'processes.json'),
      JSON.stringify(evidence, undefined, 2) + '\n',
    )
  })

  it('runs the assembled two-account Project Member question and answer race', async () => {
    for (const name of installations) {
      const item = requiredEvidence(name)
      const created = await rpc<{ workspace: { workspaceId: string } }>(
        item.hostOrigin,
        'workspace.create',
        { path: item.workspace },
      )
      workspaceIds[name] = created.workspace.workspaceId
    }

    const accounts = {
      a1: await signInFromWorkspaceSettings('a1', 'ada'),
      b1: await signIn('b1', 'grace'),
      b2: await signIn('b2', 'grace'),
    }
    expect(accounts.a1).not.toBe(accounts.b1)
    expect(accounts.b1).toBe(accounts.b2)

    for (const name of installations) {
      await postControl(name, '/identity', { accountId: accounts[name] })
    }
    await postJson(required('DEEPSEEK_BASE_URL') + '/control/member', { accountId: accounts.b1 })

    const project = await createProjectAndInvite()
    deliveryContext = {
      askerAccountId: accounts.a1,
      receiverAccountId: accounts.b1,
      projectId: project.id,
    }
    await postControl('a1', '/project', { projectId: project.id })
    await acceptInvitationOnB1()
    await closeStaleInvitation('b2')
    await signOut('b1')
    await signIn('b1', 'grace')
    await assertReceiverRoster('Online')

    await startA1SessionAndAsk()
    await assertSingleA1ComposerCard()
    const title = 'Atlas — Electron A1 acceptance'
    await Promise.all([
      openReceivingQuestion('b1', title),
      openReceivingQuestion('b2', title),
    ])

    for (const name of ['b1', 'b2'] as const) {
      const instance = getInstance(name)
      await waitForBodyText(instance, 'Approve the guarded rollout?')
      await waitForBodyText(instance, 'decision.md')
      await waitForBodyText(instance, 'preview.html')
      await waitForBodyText(instance, 'notes.txt')
      await assertNoLocalComposerCard(name)
      await instance.saveScreenshot(join(
        required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name, 'question-pending.png',
      ))
    }

    await assertTransferredDocuments('b1')
    await focusTransferredDocument('b1', 'decision.md', 'A1 authoritative guarded rollout')
    await focusTransferredDocument('b1', 'preview.html', 'A1 authoritative guarded preview')
    await focusTransferredDocument('b1', 'notes.txt', 'A1 authoritative plain-text acceptance material.')

    const b1 = getInstance('b1')
    const b2 = getInstance('b2')
    const approve = await b1.$('//button[.//*[normalize-space(.)="approve"]]')
    const revise = await b2.$('//button[.//*[normalize-space(.)="revise"]]')
    await approve.waitForClickable({ timeout: 10_000 })
    await revise.waitForClickable({ timeout: 10_000 })
    await Promise.all([approve.click(), revise.click()])
    const submitB1 = await b1.$('//button[normalize-space(.)="Submit"]')
    const submitB2 = await b2.$('//button[normalize-space(.)="Submit"]')
    await Promise.all([
      submitB1.waitForClickable({ timeout: 10_000 }),
      submitB2.waitForClickable({ timeout: 10_000 }),
    ])
    await Promise.all([submitB1.click(), submitB2.click()])

    const winner = await waitForAnswerRace(b1, b2)
    const loser = winner === 'b1' ? 'b2' : 'b1'
    const a1 = getInstance('a1')
    await waitForBodyText(a1, 'Project member accepted the guarded rollout.')

    await Promise.all([
      a1.saveScreenshot(join(required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), 'a1', 'answer-returned.png')),
      getInstance(winner).saveScreenshot(join(
        required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), winner, 'answered-here.png',
      )),
      getInstance(loser).saveScreenshot(join(
        required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), loser, 'answered-elsewhere.png',
      )),
    ])
    await assertA1SessionLog()
    await assertNoReceiverModelOutput('b1')
    await assertNoReceiverModelOutput('b2')
  })

  it('renders expiry, withdrawal, supersede, and offline no-queue outcomes', async () => {
    const expiry = {
      token: 'expiry', title: 'Electron expiry acceptance', originSessionId: 'session-electron-expiry',
      question: 'Should this expiring question proceed?', background: 'Leave this question unanswered.',
    }
    await startControlAsk(expiry)
    await Promise.all([
      openReceivingQuestion('b1', expiry.title, expiry.question),
      openReceivingQuestion('b2', expiry.title, expiry.question),
    ])
    await assertNoLocalComposerCard('b1')
    await assertNoLocalComposerCard('b2')
    await expectAskFailure(expiry.token, 'QUESTION_EXPIRED', 45_000)
    await Promise.all([
      waitForBodyText(getInstance('b1'), 'Expired', 45_000),
      waitForBodyText(getInstance('b2'), 'Expired', 45_000),
    ])
    await Promise.all([
      saveEvidence('b1', 'expired.png'),
      saveEvidence('b2', 'expired.png'),
    ])

    const withdrawn = {
      token: 'withdrawn', title: 'Electron withdrawal acceptance', originSessionId: 'session-electron-withdrawn',
      question: 'Should this withdrawn question proceed?', background: 'The initiator will cancel this ask.',
    }
    await startControlAsk(withdrawn)
    await Promise.all([
      openReceivingQuestion('b1', withdrawn.title, withdrawn.question),
      openReceivingQuestion('b2', withdrawn.title, withdrawn.question),
    ])
    await assertNoLocalComposerCard('b1')
    await postControl('a1', '/withdraw', { token: withdrawn.token })
    await expectAskFailure(withdrawn.token, 'QUESTION_WITHDRAWN')
    await Promise.all([
      waitForBodyText(getInstance('b1'), 'Withdrawn'),
      waitForBodyText(getInstance('b2'), 'Withdrawn'),
    ])
    await Promise.all([
      saveEvidence('b1', 'withdrawn.png'),
      saveEvidence('b2', 'withdrawn.png'),
    ])

    const original = {
      token: 'superseded-original', title: 'Electron supersede acceptance',
      originSessionId: 'session-electron-supersede',
      question: 'Should the original plan proceed?', background: 'This question will be replaced.',
    }
    await startControlAsk(original)
    await Promise.all([
      openReceivingQuestion('b1', original.title, original.question),
      openReceivingQuestion('b2', original.title, original.question),
    ])
    const replacement = {
      token: 'superseded-replacement', title: original.title,
      originSessionId: original.originSessionId,
      question: 'Should the replacement plan proceed?', background: 'This is the authoritative replacement.',
    }
    await startControlAsk(replacement)
    await expectAskFailure(original.token, 'QUESTION_SUPERSEDED')
    for (const name of ['b1', 'b2'] as const) {
      await waitForBodyText(getInstance(name), 'Superseded by a newer question')
      await waitForBodyText(getInstance(name), replacement.question)
    }
    await Promise.all([
      saveEvidence('b1', 'superseded.png'),
      saveEvidence('b2', 'superseded.png'),
    ])
    await postControl('a1', '/withdraw', { token: replacement.token })
    await expectAskFailure(replacement.token, 'QUESTION_WITHDRAWN')

    const deliveriesBefore = await brokerDeliveryCount()
    await postControl('b1', '/online', { online: false })
    await postControl('b2', '/online', { online: false })
    const offline = {
      token: 'offline', title: 'Electron offline no-queue acceptance',
      originSessionId: 'session-electron-offline',
      question: 'This offline ask must not queue.', background: 'No receiver Installation is online.',
    }
    await startControlAsk(offline)
    await expectAskFailure(offline.token, 'MEMBER_OFFLINE')
    expect(await brokerDeliveryCount()).toBe(deliveriesBefore)
    await postControl('b1', '/online', { online: true })
    await postControl('b2', '/online', { online: true })
    await getInstance('b1').pause(1_000)
    for (const name of ['b1', 'b2'] as const) {
      const row = await getInstance(name).$(`//*[@role="treeitem" and contains(normalize-space(.), "${offline.title}")]`)
      expect(await row.isExisting()).toBe(false)
    }
    await Promise.all([signOut('b1'), signOut('b2')])
    await getInstance('a1').pause(5_500)
    await assertReceiverRoster('Offline')
  })
})

function getInstance(name: InstallationName): WebdriverIO.Browser {
  return (browser as unknown as WebdriverIO.MultiRemoteBrowser).getInstance(name)
}

function requiredEvidence(name: InstallationName): InstallationEvidence {
  const value = evidence[name]
  if (value === undefined) throw new Error(`${name} boot evidence is unavailable`)
  return value
}

async function signIn(name: InstallationName, login: string): Promise<string> {
  const instance = getInstance(name)
  await switchToSessionSurface(instance)
  await (await instance.$('button[aria-haspopup="dialog"]')).click()
  await switchToOverlaySurface(instance)
  await clickExactButton(instance, 'Mobile pairing')
  return await finishPlatformSignIn(name, login)
}

async function signInFromWorkspaceSettings(name: InstallationName, login: string): Promise<string> {
  const instance = getInstance(name)
  await openWorkspaceSettings(instance)
  const dialog = await instance.$('[role="dialog"][aria-label="Workspace settings"]')
  await waitForBodyText(instance, 'Platform Account required')
  await waitForBodyText(instance, 'Project Members uses the same Platform Account as Mobile pairing.')
  await instance.saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name, 'project-members-sign-in-gate.png',
  ))
  await clickExactButton(instance, 'Sign in to Platform')
  await switchToOverlaySurface(instance)
  await waitForBodyText(instance, 'Mobile pairing')
  const accountId = await finishPlatformSignIn(name, login)
  await dialog.waitForExist({ timeout: 10_000 })
  await instance.waitUntil(async () => !await (await dialog.$('//button[normalize-space(.)="Sign in to Platform"]')).isExisting(), {
    timeout: 10_000,
    timeoutMsg: 'Workspace settings did not resume after Platform Account sign-in',
  })
  await (await dialog.$('input[aria-label="Cloud project name"]')).waitForExist({
    timeout: 10_000,
    timeoutMsg: 'Workspace settings did not finish Project recovery after Platform Account sign-in',
  })
  await instance.saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name, 'project-members-signed-in-resumed.png',
  ))
  await (await dialog.$('button[aria-label="Close"]')).click()
  return accountId
}

async function finishPlatformSignIn(name: InstallationName, login: string): Promise<string> {
  const instance = getInstance(name)
  const consent = await instance.$('input[type="checkbox"]')
  if (!await consent.isSelected()) await consent.click()
  await clickExactButton(instance, 'Continue to GitHub')
  let snapshot: {
    status?: string
    account?: { id?: string; githubLogin?: string }
  } | undefined
  await instance.waitUntil(async () => {
    try {
      snapshot = await instance.execute(async () => await (window as unknown as {
        dshDesktop?: { accountGetSnapshot(): Promise<unknown> }
      }).dshDesktop?.accountGetSnapshot()) as typeof snapshot
      return snapshot?.status === 'signed-in'
        && snapshot.account?.githubLogin === login
        && typeof snapshot.account.id === 'string'
    } catch {
      return false
    }
  }, { timeout: 30_000, timeoutMsg: `Platform Account ${login} did not become signed in` })
  if (snapshot?.status !== 'signed-in' || typeof snapshot.account?.id !== 'string') {
    throw new Error(`Platform Account ${login} did not expose a signed-in identity`)
  }
  await instance.saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name,
    'platform-account.png',
  ))
  await instance.keys(['Escape'])
  await switchToSessionSurface(instance)
  return snapshot.account.id
}

async function createProjectAndInvite(): Promise<{ id: string }> {
  const instance = getInstance('a1')
  await openWorkspaceSettings(instance)
  const dialog = await instance.$('[role="dialog"][aria-label="Workspace settings"]')
  await (await dialog.$('input[aria-label="Cloud project name"]')).setValue('Atlas')
  await clickExactButton(instance, 'Create cloud project')
  await waitForBodyText(instance, 'Bound cloud project: Atlas')
  const project = await instance.execute(async remote =>
    await (window as unknown as {
      dshDesktop?: { projectMembership?: { projectByRemote(value: string): Promise<unknown> } }
    }).dshDesktop?.projectMembership?.projectByRemote(remote),
  'https://github.com/gestaltrun/atlas') as { id?: string } | undefined
  if (typeof project?.id !== 'string') throw new Error('A1 project creation did not expose the Project id')
  await (await dialog.$('input[aria-label="GitHub login"]')).setValue('grace')
  await clickExactButton(instance, 'Invite')
  await waitForBodyText(instance, 'Pending invitations')
  await (await dialog.$('button[aria-label="Close"]')).click()
  return { id: project.id }
}

async function acceptInvitationOnB1(): Promise<void> {
  const instance = getInstance('b1')
  await switchToSessionSurface(instance)
  const invitation = await instance.$('[role="dialog"][aria-label="Project invitation"]')
  await invitation.waitForExist({ timeout: 30_000 })
  await clickExactButton(instance, 'Accept')
  const link = await instance.$('[role="dialog"][aria-label="Link a local workspace"]')
  await link.waitForExist({ timeout: 10_000 })
  await (await link.$('button[aria-label="Close"]')).click()
  await link.waitForExist({ reverse: true, timeout: 10_000 })
  const pending = await instance.execute(async () => await (window as unknown as {
    dshDesktop?: { projectMembership?: { pendingInvitations(): Promise<unknown[]> } }
  }).dshDesktop?.projectMembership?.pendingInvitations())
  expect(pending).toHaveLength(1)
  await invitation.waitForExist({ timeout: 35_000 })
  await instance.saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), 'b1', 'invitation-still-pending.png',
  ))
  await clickExactButton(instance, 'Accept')
  await link.waitForExist({ timeout: 10_000 })
  await (await link.$('input[name="wizard-link-candidate"]')).click()
  await clickExactButton(instance, 'Link and join')
  await link.waitForExist({ reverse: true, timeout: 15_000 })
}

async function closeStaleInvitation(name: InstallationName): Promise<void> {
  const instance = getInstance(name)
  await switchToSessionSurface(instance)
  const dialog = await instance.$('[role="dialog"][aria-label="Project invitation"]')
  if (await dialog.isExisting()) await (await dialog.$('button[aria-label="Close"]')).click()
}

async function assertReceiverRoster(presence: 'Online' | 'Offline'): Promise<void> {
  const instance = getInstance('a1')
  await openWorkspaceSettings(instance)
  const dialog = await instance.$('[role="dialog"][aria-label="Workspace settings"]')
  await waitForBodyText(instance, 'grace')
  const graceRow = await dialog.$('//li[.//*[normalize-space(.)="grace"]]')
  await graceRow.waitForExist({ timeout: 10_000 })
  await (await graceRow.$(`[title="${presence}"]`)).waitForExist({ timeout: 10_000 })
  await instance.saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), 'a1', `project-roster-${presence.toLowerCase()}.png`,
  ))
  await (await dialog.$('button[aria-label="Close"]')).click()
}

async function signOut(name: 'b1' | 'b2'): Promise<void> {
  const instance = getInstance(name)
  await switchToSessionSurface(instance)
  await instance.execute(async () => await (window as unknown as {
    dshDesktop?: { accountSignOut(): Promise<unknown> }
  }).dshDesktop?.accountSignOut())
  await instance.waitUntil(async () => {
    const snapshot = await instance.execute(async () => await (window as unknown as {
      dshDesktop?: { accountGetSnapshot(): Promise<{ status?: string }> }
    }).dshDesktop?.accountGetSnapshot())
    return snapshot?.status === 'idle'
  }, { timeout: 15_000, timeoutMsg: `${name} Platform Account did not sign out` })
}

async function openWorkspaceSettings(instance: WebdriverIO.Browser): Promise<void> {
  await switchToSessionSurface(instance)
  const row = await instance.$('//*[@role="treeitem" and contains(normalize-space(.), "workspace")]')
  await row.waitForExist({ timeout: 15_000 })
  await row.moveTo()
  const actions = await instance.$('button[aria-label="Workspace actions for workspace"]')
  await actions.waitForClickable({ timeout: 5_000 })
  await actions.click()
  await clickExactButtonOrMenuItem(instance, 'Workspace settings')
  await (await instance.$('[role="dialog"][aria-label="Workspace settings"]')).waitForExist({ timeout: 10_000 })
}

async function startA1SessionAndAsk(): Promise<void> {
  const instance = getInstance('a1')
  await switchToSessionSurface(instance)
  const empty = await instance.$('textarea[placeholder="Choose a workspace to start"]')
  if (await empty.isExisting()) {
    await empty.click()
    await clickExactButtonOrMenuItem(instance, 'workspace')
  }
  const composer = await instance.$('textarea[placeholder="Describe what you want to build"]')
  await composer.waitForEnabled({ timeout: 20_000 })
  await composer.setValue('Ask Grace whether the guarded rollout should proceed after reviewing all three materials.')
  await instance.keys(['Enter'])
  await waitForBodyText(instance, 'Ask Grace whether the guarded rollout should proceed')
}

async function openReceivingQuestion(
  name: InstallationName,
  title: string,
  question = 'Approve the guarded rollout?',
): Promise<void> {
  const instance = getInstance(name)
  await switchToSessionSurface(instance)
  const row = await instance.$(`//*[@role="treeitem" and contains(normalize-space(.), "${title}")]`)
  await row.waitForExist({ timeout: 30_000 })
  await row.click()
  await waitForBodyText(instance, question)
}

async function waitForAnswerRace(
  b1: WebdriverIO.Browser,
  b2: WebdriverIO.Browser,
): Promise<'b1' | 'b2'> {
  let winner: 'b1' | 'b2' | undefined
  await b1.waitUntil(async () => {
    const [b1Text, b2Text] = await Promise.all([
      (await b1.$('body')).getText(),
      (await b2.$('body')).getText(),
    ])
    if (b1Text.includes('Answered on B2 Electron')) winner = 'b2'
    if (b2Text.includes('Answered on B1 Electron')) winner = 'b1'
    return winner !== undefined
  }, { timeout: 30_000, timeoutMsg: 'B1 and B2 did not converge on one answer winner' })
  if (winner === undefined) throw new Error('answer race winner is unavailable')
  return winner
}

async function focusTransferredDocument(
  name: InstallationName,
  filename: string,
  marker: string,
): Promise<void> {
  const instance = getInstance(name)
  const chip = await instance.$(`//button[.//*[normalize-space(.)="${filename}"]]`)
  await chip.waitForClickable({ timeout: 5_000 })
  await chip.click()
  if (filename.endsWith('.html')) {
    const preview = await instance.$(`//iframe[@title="${filename}"]`)
    await preview.waitForExist({ timeout: 10_000 })
    await instance.waitUntil(async () => (await preview.getAttribute('srcdoc'))?.includes(marker) === true, {
      timeout: 10_000,
      timeoutMsg: `restricted HTML preview did not contain ${JSON.stringify(marker)}`,
    })
  }
  else {
    await waitForBodyText(instance, marker)
  }
  await instance.saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name, `${filename.replace('.', '-')}-focused.png`,
  ))
  const foldedBar = await instance.$('//button[@aria-label="Remote · Ada"]')
  if (await foldedBar.isClickable()) {
    await foldedBar.click()
  }
  await waitForBodyText(instance, 'Approve the guarded rollout?')
}

async function assertTransferredDocuments(name: InstallationName): Promise<void> {
  const workspace = requiredEvidence(name).workspace
  let cached: string[] = []
  await getInstance(name).waitUntil(async () => {
    const { readdir } = await import('node:fs/promises')
    const root = join(workspace, '.dsh', 'member-questions')
    const questions = await readdir(root).catch(() => [])
    cached = []
    for (const question of questions) {
      const files = await readdir(join(root, question)).catch(() => [])
      cached.push(...files.map(file => join(root, question, file)))
    }
    return cached.length >= 3
  }, { timeout: 10_000, timeoutMsg: `${name} did not cache transferred documents` })
  const bodies = await Promise.all(cached.map(async path => await readFile(path, 'utf8')))
  expect(bodies.some(text => text.includes('A1 authoritative guarded rollout'))).toBe(true)
  expect(bodies.some(text => text.includes('A1 authoritative guarded preview'))).toBe(true)
  expect(bodies.some(text => text.includes('A1 authoritative plain-text acceptance material.'))).toBe(true)
  expect(bodies.every(text => Buffer.byteLength(text) > 32 * 1_024)).toBe(true)
}

async function assertA1SessionLog(): Promise<void> {
  const item = requiredEvidence('a1')
  const listed = await rpc<{ items: Array<{ sessionId: string }> }>(item.hostOrigin, 'session.list', {})
  let combined = ''
  for (const session of listed.items) {
    combined += JSON.stringify(await rpc(item.hostOrigin, 'session.history', {
      sessionId: session.sessionId,
      maxMessages: 20,
    }))
  }
  expect(combined).toContain('member-question/asked')
  expect(combined).toContain('member-question/outcome')
  expect(combined).toContain('answered')
  expect(combined).toContain('approve')
}

async function assertSingleA1ComposerCard(): Promise<void> {
  const instance = getInstance('a1')
  const composerCards = await instance.$$('[data-composer-card]')
  const memberComposer = await instance.$('textarea[aria-label="Answer this member question"]')
  expect(composerCards).toHaveLength(1)
  expect(await memberComposer.isExisting()).toBe(false)
}

async function assertNoLocalComposerCard(name: 'b1' | 'b2'): Promise<void> {
  const instance = getInstance(name)
  const composerCard = await instance.$('[data-composer-card]')
  const productComposer = await instance.$('textarea[placeholder="Describe what you want to build"]')
  const memberComposer = await instance.$('textarea[aria-label="Answer this member question"]')
  expect(await composerCard.isExisting()).toBe(false)
  expect(await productComposer.isExisting()).toBe(false)
  expect(await memberComposer.isExisting()).toBe(false)
}

async function assertNoReceiverModelOutput(name: 'b1' | 'b2'): Promise<void> {
  const item = requiredEvidence(name)
  const listed = await rpc<{ items: Array<{ sessionId: string }> }>(item.hostOrigin, 'session.list', {})
  const histories = await Promise.all(listed.items.map(async session => await rpc(item.hostOrigin, 'session.history', {
    sessionId: session.sessionId,
    maxMessages: 20,
  })))
  expect(JSON.stringify(histories)).not.toContain('assistant/message')
}

async function startControlAsk(input: {
  readonly token: string
  readonly title: string
  readonly originSessionId: string
  readonly question: string
  readonly background: string
}): Promise<void> {
  const context = deliveryContext
  if (context === undefined) throw new Error('Project Member delivery context is unavailable')
  await postControl('a1', '/ask', {
    ...input,
    toAccountId: context.receiverAccountId,
    askerAccountId: context.askerAccountId,
    projectId: context.projectId,
    projectName: 'Atlas',
  })
}

async function expectAskFailure(token: string, code: string, timeout = 30_000): Promise<void> {
  let status: ControlAskStatus = { state: 'pending' }
  await getInstance('a1').waitUntil(async () => {
    status = await postControl<ControlAskStatus>('a1', '/status', { token })
    return status.state !== 'pending'
  }, { timeout, timeoutMsg: `control ask ${token} did not settle` })
  expect(status).toEqual({ state: 'failed', code })
}

async function brokerDeliveryCount(): Promise<number> {
  const response = await fetch(required('DSH_MEMBER_QUESTION_KEYLESS_ORIGIN') + '/__audit')
  if (!response.ok) throw new Error(`keyless broker audit failed with HTTP ${String(response.status)}`)
  const body = await response.json() as { entries?: Array<{ operation?: unknown }> }
  if (!Array.isArray(body.entries)) throw new Error('keyless broker audit returned invalid JSON')
  return body.entries.filter(entry => entry.operation === 'deliver').length
}

async function saveEvidence(name: InstallationName, filename: string): Promise<void> {
  await getInstance(name).saveScreenshot(join(
    required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR'), name, filename,
  ))
}

async function postControl<T = unknown>(name: InstallationName, path: string, body: unknown): Promise<T> {
  const file = join(requiredEvidence(name).dshHome, 'member-question-e2e-control.json')
  let origin = ''
  await getInstance(name).waitUntil(async () => {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text === '') return false
    const parsed = JSON.parse(text) as { origin?: unknown }
    if (typeof parsed.origin !== 'string') return false
    origin = parsed.origin
    return true
  }, { timeout: 10_000, timeoutMsg: `${name} exposed no member-question control` })
  const attempts = path === '/ask' ? 1 : 3
  let failure: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await postJson<T>(origin + path, body)
    }
    catch (error) {
      failure = error
      if (attempt < attempts) await getInstance(name).pause(100)
    }
  }
  throw failure
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    throw new Error(`POST ${url} transport failed: ${String(cause)}`, { cause })
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`POST ${url} failed with HTTP ${String(response.status)}: ${text}`)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function rpc<T = unknown>(origin: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `electron-${crypto.randomUUID()}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${String(response.status)}: ${await response.text()}`)
  const body = await response.json() as {
    result?: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (body.result === undefined) throw new Error(`${method} returned no RPC result`)
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

async function clickExactButton(instance: WebdriverIO.Browser, label: string): Promise<void> {
  const button = await instance.$(`//button[normalize-space(.)="${label}"]`)
  await button.waitForClickable({ timeout: 10_000 })
  await button.click()
}

async function clickExactButtonOrMenuItem(instance: WebdriverIO.Browser, label: string): Promise<void> {
  const target = await instance.$(`//*[self::button or @role="menuitem"][normalize-space(.)="${label}"]`)
  await target.waitForClickable({ timeout: 10_000 })
  await target.click()
}

async function waitForBodyText(
  instance: WebdriverIO.Browser,
  text: string,
  timeout = 30_000,
): Promise<void> {
  await instance.waitUntil(async () => (await instance.$('body')).getText().then(value => value.includes(text)), {
    timeout,
    timeoutMsg: `visible text did not contain ${JSON.stringify(text)}`,
  })
}

async function switchToOverlaySurface(instance: WebdriverIO.Browser): Promise<void> {
  await instance.waitUntil(async () => {
    for (const handle of await instance.getWindowHandles()) {
      await instance.switchToWindow(handle)
      if (await instance.execute(() => document.documentElement.hasAttribute('data-dsh-desktop-overlay'))) return true
    }
    return false
  }, { timeout: 10_000, timeoutMsg: 'Desktop Settings overlay did not open' })
}

async function switchToSessionSurface(instance: WebdriverIO.Browser): Promise<void> {
  const handles = await instance.getWindowHandles()
  for (const handle of handles) {
    await instance.switchToWindow(handle)
    const overlay = await instance.execute(() => document.documentElement.hasAttribute('data-dsh-desktop-overlay'))
    if (!overlay) return
  }
  throw new Error('Desktop exposed no Session Surface window')
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}
