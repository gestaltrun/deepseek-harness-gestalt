// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseInstallationId,
  parseMobileInstallationPresentation,
  loadOperatedPlatformEnvironment,
  type AccountSessionView,
  type LoginAttemptView,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountInstallation,
  type PlatformAccountTransport,
} from '@deepseek-ai/dsh-platform-account-client'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime, installCompanionRuntime } from '../src/companion-lifecycle.ts'
import { CompanionAttachmentDeliveryUncertainError } from '../src/companion-attachment.ts'
import { mountMobileEntry } from '../src/mobile-entry.tsx'
import type {
  MobileCompanionConnectionChannel, ValidatedDesktopSurfaceResync,
} from '../src/companion-surface.ts'
import { fixedMobilePresentationClock } from '../src/mobile-clock.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

const sid = (value: string): SessionId => value as SessionId

const environment = loadOperatedPlatformEnvironment({
  environment: 'production', origin: 'https://platform.fixture.example',
  callbackUrl: 'https://platform.fixture.example/v1/account/oauth/github/callback',
  githubClientId: 'mobile-fixture', credentialReference: 'credentials://fixture',
  databaseIdentity: 'database-fixture', identityNamespace: 'namespace-fixture',
})
const installationIdentity = crypto.randomUUID()
const installationPlatform = crypto.getRandomValues(new Uint8Array(1))[0]! % 2 === 0 ? 'ios' : 'android'

const attempt: LoginAttemptView = {
  id: 'attempt-mobile-snapshot' as never,
  state: 'state-mobile-snapshot',
  authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=mobile',
  pollingToken: 'polling-mobile-snapshot',
  expiresAt: Date.now() + 300_000,
}

const accountSession: AccountSessionView = {
  sessionId: 'session-mobile-snapshot' as never,
  account: {
    id: 'account-mobile-snapshot' as never,
    githubId: 583231,
    githubLogin: 'fixture-account',
    avatarUrl: 'https://avatars.example/fixture-account',
  },
  accessToken: 'access-mobile-snapshot',
  refreshToken: 'refresh-mobile-snapshot',
  accessExpiresAt: Date.now() + 900_000,
  refreshExpiresAt: Date.now() + 2_592_000_000,
}

afterEach(cleanup)

describe('Mobile shipped entry foreground mutation gate', () => {
  it('binds receipts and history pages to the current-generation bundled entry', async () => {
    const runtime = new CompanionForegroundRuntime()
    const disposeRuntime = installCompanionRuntime(runtime)
    const installation = installationWithCompletedLogin()
    const root = document.createElement('div')
    document.body.append(root)
    let rejectAttachment: ((reason: unknown) => void) | undefined
    const attachmentCompletion = new Promise<void>((_resolve, reject) => { rejectAttachment = reject })

    const mounted = mountMobileEntry(root, {
      installation,
      companion: runtime,
      clock: fixedMobilePresentationClock(10_000),
    })
    const surface = mounted.companionSurface

    fireEvent.click(await screen.findByRole('checkbox'))
    const login = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(login.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(login)
    await screen.findByText('@fixture-account')

    runtime.configure({
      routeId: parseRelayRouteId('route-mobile-snapshot'),
      endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
      revision: 1,
    })
    runtime.markConnectionOpen()
    const firstChannel = connectionChannel(attachmentCompletion)
    const firstResync = surface.bindAuthenticatedConnection(firstChannel)
    if (firstResync === undefined) throw new Error('expected first Desktop surface resync receiver')
    firstResync.acceptValidatedDesktopResync({
      type: 'desktop-resync',
      version: 1,
      authenticated: true,
      desktopName: 'Guarded Desktop',
      sessions: guardedSessions(),
      workspaces: [{
        workspaceId: 'guarded-workspace',
        path: '/work', title: 'Work', sessionIds: ['guarded-session'],
        createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
      }],
      conversations: [guardedConversation()],
    })
    await screen.findByRole('treeitem', { name: /Guarded Session/ })

    expect(screen.getByRole('button', { name: 'New ungrouped Session' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('treeitem', { name: /Guarded Session/ }))
    expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false)
    firstChannel.mutations.settle.mockResolvedValueOnce({ accepted: false, reason: 'not-pending' })
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false)
    })
    expect(firstChannel.mutations.settle).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'guarded-session', interactionId: 'guarded-approval',
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(firstChannel.mutations.loadOlder).toHaveBeenCalledWith('guarded-session', 2)
    firstResync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true, desktopName: 'Guarded Desktop',
      sessions: guardedSessions(),
      workspaces: [{
        workspaceId: 'guarded-workspace', path: '/work', title: 'Work', sessionIds: ['guarded-session'],
        createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
      }],
      conversations: [guardedConversation(true)],
    })
    await screen.findByText('Older page')
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected current Companion result receiver')
    fireEvent.click(screen.getByRole('button', { name: 'New Session in Work' }))
    expect(firstChannel.mutations.create).toHaveBeenCalledWith({ workspace: 'guarded-workspace' })
    results.acceptValidatedCompanionResult({
      type: 'session-created',
      operationId: parseCompanionOperationId('create-workspace-snapshot'),
      sessionId: parseCompanionSessionId('created-workspace-session'),
      committedAt: 1,
    })
    firstResync.acceptValidatedDesktopResync(createdSessionsProjection('workspace'))
    await screen.findByRole('heading', { name: 'Workspace created' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(within(screen.getByRole('region', { name: 'Work' })).getByRole('treeitem', { name: /New Session/ }))
      .toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'New ungrouped Session' }))
    expect(firstChannel.mutations.create).toHaveBeenLastCalledWith({})
    results.acceptValidatedCompanionResult({
      type: 'session-created',
      operationId: parseCompanionOperationId('create-ungrouped-snapshot'),
      sessionId: parseCompanionSessionId('created-ungrouped-session'),
      committedAt: 2,
    })
    firstResync.acceptValidatedDesktopResync(createdSessionsProjection('ungrouped'))
    await screen.findByRole('heading', { name: 'Ungrouped created' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect([
      screen.getByRole('region', { name: 'Work' }).textContent,
      screen.getByRole('region', { name: 'Ungrouped' }).textContent,
    ]).toMatchInlineSnapshot(`
      [
        "WorkNew Session in WorkWorkspace creatednowWaiting for approvalGuarded Sessionnow",
        "UngroupedNew Session",
      ]
    `)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Desktop Sessions' }), {
      target: { value: 'authoritative' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    results.acceptValidatedCompanionResult({
      type: 'session-search',
      operationId: parseCompanionOperationId('mobile-snapshot-search'),
      items: [{
        sessionId: parseCompanionSessionId('uncached-authoritative-session'),
        snippet: 'Desktop-only authoritative hit',
      }],
      hasMore: false,
    })
    await screen.findByText('Desktop-only authoritative hit')
    expect(screen.getByRole('region', { name: 'Desktop search results' }).textContent).toMatchInlineSnapshot(
      '"Desktop search resultsuncached-authoritative-sessionDesktop-only authoritative hit"',
    )
    surface.search('')
    surface.attach(sid('guarded-session'), selectedFile())
    results.acceptValidatedCompanionResult({
      type: 'attachment-rejected',
      operationId: parseCompanionOperationId('mobile-snapshot-attachment'),
      reason: 'hash-mismatch',
    })
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Desktop rejected the attachment: hash-mismatch')
    surface.attach(sid('guarded-session'), selectedFile())
    rejectAttachment?.(new CompanionAttachmentDeliveryUncertainError(
      parseCompanionOperationId('mobile-snapshot-attachment'),
      new Error('connection replaced'),
    ))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent)
        .toBe('Attachment delivery is uncertain; reconnect to reconcile it before retrying.')
    })

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    firstResync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true, desktopName: 'Stale Desktop',
      sessions: guardedSessions(), workspaces: [], conversations: [],
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New ungrouped Session' }).hasAttribute('disabled')).toBe(true)
    })
    expect(visibleMutationControls()).toMatchInlineSnapshot(`
      [
        "button:New ungrouped Session:disabled",
        "button:New Session in Work:disabled",
      ]
    `)

    runtime.reportConnectionFailure({
      code: 'COMPANION_UPDATE_REQUIRED',
      message: 'Desktop update required',
      updateEndpoint: 'desktop',
    })
    expect((await screen.findByText('Update Desktop to connect from this Mobile.')).textContent)
      .toMatchInlineSnapshot('"Update Desktop to connect from this Mobile."')

    fireEvent.click(screen.getByRole('treeitem', { name: /Guarded Session/ }))
    expect(visibleMutationControls()).toMatchInlineSnapshot(`
      [
        "button:Allow once:disabled",
      ]
    `)

    mounted.unmount()
    disposeRuntime()
  })
})

function guardedSessions() {
  return {
    ids: ['guarded-session'],
    byId: {
      'guarded-session': {
        id: 'guarded-session', title: 'Guarded Session', displayTitle: 'Guarded Session', cwd: '/work',
        running: true, pendingInteraction: 'approval' as const, blank: false, updatedAt: 1,
      },
    },
    current: null,
    phase: 'ready' as const,
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: null,
  }
}

function createdSessionsProjection(
  created: 'workspace' | 'ungrouped',
): ValidatedDesktopSurfaceResync {
  const workspaceBlank = created === 'workspace'
  const ungroupedBlank = created === 'ungrouped'
  return {
    type: 'desktop-resync', version: 1, authenticated: true, desktopName: 'Guarded Desktop',
    sessions: {
      ids: [
        ...(ungroupedBlank ? ['created-ungrouped-session'] : []),
        'created-workspace-session',
        'guarded-session',
      ],
      byId: {
        'guarded-session': guardedSessions().byId['guarded-session'],
        'created-workspace-session': {
          id: 'created-workspace-session', title: 'Workspace created', displayTitle: 'Workspace created',
          cwd: '/work', running: false, blank: workspaceBlank, updatedAt: 2,
        },
        ...(ungroupedBlank
          ? {
            'created-ungrouped-session': {
              id: 'created-ungrouped-session', title: 'Ungrouped created', displayTitle: 'Ungrouped created',
              running: false, blank: true, updatedAt: 3,
            },
          }
          : {}),
      },
      current: null, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: null,
    },
    workspaces: [{
      workspaceId: 'guarded-workspace', path: '/work', title: 'Work',
      sessionIds: ['created-workspace-session', 'guarded-session'],
      createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
    }],
    conversations: [guardedConversation(true)],
  }
}

function installationWithCompletedLogin(): PlatformAccountInstallation {
  const transport: PlatformAccountTransport = {
    environment,
    beginLogin: vi.fn<PlatformAccountTransport['beginLogin']>().mockResolvedValue(attempt),
    pollLogin: vi.fn<PlatformAccountTransport['pollLogin']>().mockResolvedValue({
      status: 'complete', ...accountSession,
    }),
    refresh: vi.fn<PlatformAccountTransport['refresh']>(),
    current: vi.fn<PlatformAccountTransport['current']>(),
    signOut: vi.fn<PlatformAccountTransport['signOut']>().mockResolvedValue(undefined),
  }
  return new PlatformAccountInstallation({
    environment,
    installationId: parseInstallationId(`mobile-${installationIdentity}`),
    installationKind: 'mobile',
    presentation: parseMobileInstallationPresentation({
      name: `Mobile ${installationIdentity}`,
      platform: installationPlatform,
    }),
    transport,
    store: new MemoryInstallationAccountStore(),
    systemBrowser: { open: vi.fn() },
    crypto: globalThis.crypto,
  })
}

function guardedConversation(complete = false): ValidatedDesktopSurfaceResync['conversations'][number] {
  return {
    sessionId: 'guarded-session',
    nodes: [
      ...(complete
        ? [{
          kind: 'user' as const, seq: 1, time: 1, source: null,
          content: [{ type: 'text' as const, text: 'Older page' }],
        }]
        : []),
      {
        kind: 'user' as const, seq: 2, time: 2, source: null,
        content: [{ type: 'text' as const, text: 'Current page' }],
      },
    ],
    turnTimings: [],
    turnEnds: [],
    partial: null,
    runningCalls: [],
    pending: [{
      kind: 'approval', interactionId: 'guarded-approval', sessionId: 'guarded-session',
      payload: { approvalId: 'guarded-approval-id' as never, toolName: 'write', reason: 'Allow write' },
    }],
    queue: [],
    running: true,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: !complete,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function connectionChannel(attachmentCompletion: Promise<void>) {
  const createOperationIds = ['create-workspace-snapshot', 'create-ungrouped-snapshot'] as const
  let createIndex = 0
  const mutations = {
    create: vi.fn<MobileCompanionConnectionChannel['mutations']['create']>(() => {
      const operationId = createOperationIds[createIndex]
      if (operationId === undefined) throw new Error('unexpected extra Session creation')
      createIndex += 1
      return { operationId: parseCompanionOperationId(operationId), completion: Promise.resolve() }
    }),
    submit: vi.fn<MobileCompanionConnectionChannel['mutations']['submit']>(() => ({
      operationId: parseCompanionOperationId('submit-snapshot'), completion: Promise.resolve(),
    })),
    cancel: vi.fn<MobileCompanionConnectionChannel['mutations']['cancel']>(() => ({
      operationId: parseCompanionOperationId('cancel-snapshot'), completion: Promise.resolve(),
    })),
    attach: vi.fn<MobileCompanionConnectionChannel['mutations']['attach']>(() => ({
      operationId: parseCompanionOperationId('mobile-snapshot-attachment'),
      completion: attachmentCompletion,
    })),
    search: vi.fn<MobileCompanionConnectionChannel['mutations']['search']>(() => (
      { operationId: parseCompanionOperationId('mobile-snapshot-search'), completion: Promise.resolve() }
    )),
    observeSession: vi.fn<MobileCompanionConnectionChannel['mutations']['observeSession']>(() => ({
      operationId: parseCompanionOperationId('mobile-snapshot-observe'), completion: Promise.resolve(),
    })),
    loadOlder: vi.fn<MobileCompanionConnectionChannel['mutations']['loadOlder']>(() => ({
      operationId: parseCompanionOperationId('history-snapshot'), completion: Promise.resolve(),
    })),
    settle: vi.fn<MobileCompanionConnectionChannel['mutations']['settle']>(),
  }
  return {
    mutations,
    content: { loadImage: vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=') },
  } satisfies MobileCompanionConnectionChannel
}

function selectedFile(): File {
  return { name: 'visible.txt', arrayBuffer: async () => new ArrayBuffer(0) } as File
}

function visibleMutationControls(): string[] {
  const names = new Set(['New ungrouped Session', 'New Session in Work', 'Allow once'])
  return [...document.querySelectorAll('button, textarea')].flatMap((element) => {
    const name = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''
    if (!names.has(name)) return []
    const role = element.getAttribute('role') ?? (element instanceof HTMLTextAreaElement ? 'textbox' : 'button')
    return [`${role}:${name}:${element.hasAttribute('disabled') ? 'disabled' : 'enabled'}`]
  })
}
