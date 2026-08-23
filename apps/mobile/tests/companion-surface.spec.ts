import { describe, expect, it, vi } from 'vitest'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { CompanionAttachmentDeliveryUncertainError } from '../src/companion-attachment.ts'
import { CompanionForegroundRuntime } from '../src/companion-lifecycle.ts'
import {
  MobileCompanionSurface,
  type MobileCompanionConnectionChannel,
  type ValidatedDesktopSurfaceResync,
} from '../src/companion-surface.ts'

type SettlementReceipt = Awaited<ReturnType<MobileCompanionConnectionChannel['mutations']['settle']>>

const grant = {
  routeId: parseRelayRouteId('route-surface'),
  endpoint: 'mobile' as const,
  credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
  revision: 1,
}

describe('MobileCompanionSurface', () => {
  it('round-trips an explicit JSON projection without Maps, classes, or callbacks', () => {
    const dto = projection('session-one', 'One', true)
    const parsed = JSON.parse(JSON.stringify(dto)) as ValidatedDesktopSurfaceResync
    expect(parsed).toEqual(dto)
    expect(parsed.conversations[0]?.turnTimings).toEqual([])
    expect(parsed.conversations[0]?.pending[0]).toEqual({
      kind: 'approval', interactionId: 'approval-rpc', sessionId: 'session-one',
      payload: { approvalId: 'approval-id', toolName: 'write', reason: 'Allow write' },
    })
  })

  it('rejects class-backed values before they can synchronize a connection', () => {
    const runtime = connectedRuntime()
    const surface = new MobileCompanionSurface(runtime)
    const receiver = surface.bindAuthenticatedConnection(connectionChannel())
    if (receiver === undefined) throw new Error('expected Desktop resync receiver')
    const invalid = projection('session-one', 'One') as unknown as { conversations: unknown }
    invalid.conversations = new Map()

    expect(() => {
      receiver.acceptValidatedDesktopResync(invalid as ValidatedDesktopSurfaceResync)
    }).toThrow('must contain only JSON-compatible values')
    expect(runtime.getState().synchronized).toBe(false)
  })

  it('does not synchronize when a JSON projection cannot build presentation carriers', () => {
    const runtime = connectedRuntime()
    const surface = new MobileCompanionSurface(runtime)
    const receiver = surface.bindAuthenticatedConnection(connectionChannel())
    if (receiver === undefined) throw new Error('expected Desktop resync receiver')
    const invalid = { ...projection('session-one', 'One'), sessions: null }

    expect(() => {
      receiver.acceptValidatedDesktopResync(invalid as unknown as ValidatedDesktopSurfaceResync)
    }).toThrow()
    expect(runtime.getState().synchronized).toBe(false)
    expect(surface.mayMutate()).toBe(false)
  })

  it('binds projection, content, and mutation channels to one physical connection generation', async () => {
    const runtime = connectedRuntime()
    const firstChannel = connectionChannel()
    const surface = new MobileCompanionSurface(runtime)
    const first = surface.bindAuthenticatedConnection(firstChannel)
    if (first === undefined) throw new Error('expected Desktop resync receiver')
    first.acceptValidatedDesktopResync(projection('session-first', 'First'))
    await surface.submit('session-first', 'continue')

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    first.acceptValidatedDesktopResync(projection('session-stale', 'Stale'))
    await expect(surface.submit('session-first', 'stale')).rejects.toThrow('requires foreground synchronization')

    const replacementChannel = connectionChannel()
    const replacement = surface.bindAuthenticatedConnection(replacementChannel)
    if (replacement === undefined) throw new Error('expected replacement resync receiver')
    replacement.acceptValidatedDesktopResync(projection('session-replacement', 'Replacement'))
    await surface.submit('session-replacement', 'current')

    expect(firstChannel.mutations.submit).toHaveBeenCalledTimes(1)
    expect(firstChannel.mutations.submit).toHaveBeenCalledWith('session-first', 'continue')
    expect(replacementChannel.mutations.submit).toHaveBeenCalledOnce()
    expect(replacementChannel.mutations.submit).toHaveBeenCalledWith('session-replacement', 'current')
    expect(surface.getSnapshot().sessions.ids).toEqual(['session-replacement'])
  })

  it('publishes synchronized replacement state only after the new channel is authoritative', () => {
    const runtime = connectedRuntime()
    const firstChannel = connectionChannel()
    const surface = new MobileCompanionSurface(runtime)
    const first = surface.bindAuthenticatedConnection(firstChannel)
    if (first === undefined) throw new Error('expected Desktop resync receiver')
    first.acceptValidatedDesktopResync(projection('session-one', 'One'))

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    const replacementChannel = connectionChannel()
    const replacement = surface.bindAuthenticatedConnection(replacementChannel)
    if (replacement === undefined) throw new Error('expected replacement resync receiver')
    const dispose = runtime.subscribe(() => {
      if (runtime.getState().synchronized) void surface.submit('session-two', 'during synchronized publication')
    })
    replacement.acceptValidatedDesktopResync(projection('session-two', 'Two'))
    dispose()

    expect(firstChannel.mutations.submit).not.toHaveBeenCalled()
    expect(replacementChannel.mutations.submit).toHaveBeenCalledWith(
      'session-two', 'during synchronized publication',
    )
    expect(surface.getSnapshot().sessions.ids).toEqual(['session-two'])
  })

  it('adapts pending ids and data into local responders and returns carrier receipts', async () => {
    const runtime = connectedRuntime()
    const channel = connectionChannel()
    channel.mutations.settle.mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false, reason: 'not-pending' })
    const surface = new MobileCompanionSurface(runtime)
    const receiver = surface.bindAuthenticatedConnection(channel)
    if (receiver === undefined) throw new Error('expected Desktop resync receiver')
    receiver.acceptValidatedDesktopResync(projection('session-one', 'One', true))

    const conversation = surface.getSnapshot().conversations['session-one' as SessionId]
    const approval = conversation?.pending[0]
    const question = conversation?.pending[1]
    if (approval === undefined || question === undefined) throw new Error('expected adapted pending interactions')
    const approvalResult = { ok: true as const, value: { outcome: 'allowed-once' } }
    const questionResult = { ok: true as const, value: { answers: [{ id: 'q1', selected: ['Yes'] }] } }

    await expect(approval.respond(approvalResult)).resolves.toEqual({ accepted: true })
    await expect(question.respond(questionResult)).resolves.toEqual({ accepted: false, reason: 'not-pending' })
    expect(channel.mutations.settle).toHaveBeenNthCalledWith(1, {
      kind: 'approval', sessionId: 'session-one', interactionId: 'approval-rpc', result: approvalResult,
    })
    expect(channel.mutations.settle).toHaveBeenNthCalledWith(2, {
      kind: 'question', sessionId: 'session-one', interactionId: 'question-rpc', result: questionResult,
    })
  })

  it('refuses an old local responder after a replacement generation synchronizes', async () => {
    const runtime = connectedRuntime()
    const firstChannel = connectionChannel()
    const surface = new MobileCompanionSurface(runtime)
    const first = surface.bindAuthenticatedConnection(firstChannel)
    if (first === undefined) throw new Error('expected Desktop resync receiver')
    first.acceptValidatedDesktopResync(projection('session-one', 'One', true))
    const oldWait = surface.getSnapshot().conversations['session-one' as SessionId]?.pending[0]
    if (oldWait === undefined) throw new Error('expected old pending interaction')

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    const replacementChannel = connectionChannel()
    const replacement = surface.bindAuthenticatedConnection(replacementChannel)
    if (replacement === undefined) throw new Error('expected replacement resync receiver')
    replacement.acceptValidatedDesktopResync(projection('session-two', 'Two'))

    await expect(oldWait.respond({ ok: true, value: { outcome: 'allowed-once' } }))
      .rejects.toThrow('stale connection generation')
    expect(firstChannel.mutations.settle).not.toHaveBeenCalled()
    expect(replacementChannel.mutations.settle).not.toHaveBeenCalled()
  })

  it.each([
    ['accepted', { accepted: true }],
    ['rejected', { accepted: false, reason: 'not-pending' }],
  ] as const)('discards an old %s settlement receipt after a replacement generation synchronizes', async (_label, receipt) => {
    const runtime = connectedRuntime()
    const firstChannel = connectionChannel()
    let resolveFirst: ((receipt: SettlementReceipt) => void) | undefined
    firstChannel.mutations.settle.mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve }))
    const surface = new MobileCompanionSurface(runtime)
    const first = surface.bindAuthenticatedConnection(firstChannel)
    if (first === undefined) throw new Error('expected Desktop resync receiver')
    first.acceptValidatedDesktopResync(projection('session-one', 'One', true))
    const oldWait = surface.getSnapshot().conversations['session-one' as SessionId]?.pending[0]
    if (oldWait === undefined) throw new Error('expected old pending interaction')

    const pendingReceipt = oldWait.respond({ ok: true, value: { outcome: 'allowed-once' } })
    await vi.waitFor(() => { expect(firstChannel.mutations.settle).toHaveBeenCalledOnce() })
    runtime.forgetConnection()
    runtime.markConnectionOpen()
    const replacementChannel = connectionChannel()
    const replacement = surface.bindAuthenticatedConnection(replacementChannel)
    if (replacement === undefined) throw new Error('expected replacement resync receiver')
    replacement.acceptValidatedDesktopResync(projection('session-two', 'Two'))
    if (resolveFirst === undefined) throw new Error('expected first settlement to remain pending')
    resolveFirst(receipt)

    await expect(pendingReceipt).rejects.toThrow('stale connection generation')
    expect(surface.getSnapshot().sessions.ids).toEqual(['session-two'])
    expect(replacementChannel.mutations.settle).not.toHaveBeenCalled()
  })

  it('addresses history loading through the current generation only', () => {
    const runtime = connectedRuntime()
    const firstChannel = connectionChannel()
    const surface = new MobileCompanionSurface(runtime)
    const first = surface.bindAuthenticatedConnection(firstChannel)
    if (first === undefined) throw new Error('expected Desktop resync receiver')
    const baseline = projection('session-one', 'One')
    first.acceptValidatedDesktopResync({
      ...baseline,
      conversations: baseline.conversations.map(conversation => ({
        ...conversation,
        nodes: [{ kind: 'user', seq: 8, time: 1, content: [], source: {} }],
      })),
    })
    surface.loadOlder('session-one')
    surface.loadOlder('session-one')
    expect(firstChannel.mutations.loadOlder).toHaveBeenCalledWith('session-one', 8)
    expect(firstChannel.mutations.loadOlder).toHaveBeenCalledOnce()
    expect(surface.getSnapshot().conversations['session-one' as SessionId]?.loadingOlder).toBe(true)

    first.acceptValidatedDesktopResync(projection('session-one', 'One'))
    expect(surface.getSnapshot().conversations['session-one' as SessionId]?.loadingOlder).toBe(false)
    surface.loadOlder('session-one')
    expect(firstChannel.mutations.loadOlder).toHaveBeenCalledTimes(2)
    expect(surface.getSnapshot().conversations['session-one' as SessionId]?.loadingOlder).toBe(true)

    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected current generation result receiver')
    results.acceptValidatedCompanionResult({
      type: 'operation-failed', operationId: parseCompanionOperationId('history-default'),
      failure: { kind: 'timeout', code: 'HOST_TIMEOUT', message: 'History timed out' },
    })
    expect(surface.getSnapshot().conversations['session-one' as SessionId]?.loadingOlder).toBe(false)

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    expect(() => { surface.loadOlder('session-one') }).toThrow('requires foreground synchronization')
  })

  it('projects only Desktop-authoritative search hits and stable Host failures', () => {
    const runtime = connectedRuntime()
    const channel = connectionChannel()
    const surface = new MobileCompanionSurface(runtime)
    const resync = surface.bindAuthenticatedConnection(channel)
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync(projection('session-hit', 'Indexed'))
    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected Companion result receiver')
    surface.search('needle')
    expect(surface.getSnapshot().search).toEqual({ query: 'needle', status: 'loading', items: [], hasMore: false })
    results.acceptValidatedCompanionResult({
      type: 'session-search',
      operationId: parseCompanionOperationId('search-needle'),
      items: [{ sessionId: parseCompanionSessionId('session-hit'), snippet: 'Desktop indexed needle' }],
      hasMore: false,
    })
    expect(surface.getSnapshot().search).toEqual({
      query: 'needle',
      status: 'ready',
      items: [{ sessionId: 'session-hit', snippet: 'Desktop indexed needle' }],
      hasMore: false,
    })
    results.acceptValidatedCompanionResult({
      type: 'operation-failed',
      operationId: parseCompanionOperationId('search-needle'),
      failure: { kind: 'http', code: 'HOST_HTTP_STATUS', message: 'Desktop Host returned HTTP 400', status: 400 },
    })
    expect(surface.getSnapshot().search).toMatchObject({
      status: 'error',
      error: { kind: 'http', code: 'HOST_HTTP_STATUS', status: 400 },
    })
  })

  it('surfaces correlated prompt and history failures', async () => {
    const runtime = connectedRuntime()
    const channel = connectionChannel()
    const surface = new MobileCompanionSurface(runtime)
    const resync = surface.bindAuthenticatedConnection(channel)
    if (resync === undefined) throw new Error('expected current generation receiver')
    resync.acceptValidatedDesktopResync(projection('session-one', 'One'))
    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected current generation result receiver')

    const submission = surface.submit('session-one', 'failing prompt')
    results.acceptValidatedCompanionResult({
      type: 'operation-failed', operationId: parseCompanionOperationId('submit-default'),
      failure: { kind: 'business', code: 'prompt-refused', message: 'Desktop rejected the prompt' },
    })
    await submission
    expect(surface.getSnapshot().operationFailure?.message).toBe('Desktop rejected the prompt')

    surface.loadOlder('session-one')
    results.acceptValidatedCompanionResult({
      type: 'operation-failed', operationId: parseCompanionOperationId('history-default'),
      failure: { kind: 'timeout', code: 'HOST_TIMEOUT', message: 'History timed out' },
    })
    expect(surface.getSnapshot().operationFailure?.message).toBe('History timed out')
  })

  it('correlates attachment rejection, Host failure, and uncertain delivery instead of discarding them', async () => {
    const runtime = connectedRuntime()
    let rejectCompletion: ((reason: unknown) => void) | undefined
    const completion = new Promise<void>((_resolve, reject) => { rejectCompletion = reject })
    const channel = connectionChannel({
      attachmentOperationId: 'attachment-visible',
      attachmentCompletion: completion,
    })
    const surface = new MobileCompanionSurface(runtime)
    const resync = surface.bindAuthenticatedConnection(channel)
    if (resync === undefined) throw new Error('expected current generation receiver')
    resync.acceptValidatedDesktopResync(projection('session-one', 'One'))
    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected current generation result receiver')

    surface.attach('session-one', selectedFile())
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-visible', status: 'sending',
    })
    results.acceptValidatedCompanionResult({
      type: 'attachment-rejected',
      operationId: parseCompanionOperationId('attachment-visible'),
      reason: 'hash-mismatch',
    })
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-visible',
      status: 'rejected',
      reason: 'hash-mismatch',
      message: 'Desktop rejected the attachment: hash-mismatch',
    })

    surface.attach('session-one', selectedFile())
    results.acceptValidatedCompanionResult({
      type: 'operation-failed',
      operationId: parseCompanionOperationId('attachment-visible'),
      failure: { kind: 'http', code: 'HOST_HTTP_STATUS', message: 'Desktop Host returned HTTP 400', status: 400 },
    })
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-visible',
      status: 'failed',
      message: 'Desktop Host returned HTTP 400',
    })

    surface.attach('session-one', selectedFile())
    rejectCompletion?.(new CompanionAttachmentDeliveryUncertainError(
      parseCompanionOperationId('attachment-visible'),
      new Error('connection replaced'),
    ))
    await Promise.resolve()
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-visible',
      status: 'uncertain',
      message: 'Attachment delivery is uncertain; reconnect to reconcile it before retrying.',
    })
  })

  it('owns one attachment operation and ignores an old result after the next file starts', () => {
    const runtime = connectedRuntime()
    const channel = connectionChannel()
    channel.mutations.attach
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-old'),
        completion: new Promise<void>(() => {}),
      })
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-new'),
        completion: new Promise<void>(() => {}),
      })
    const surface = new MobileCompanionSurface(runtime)
    const resync = surface.bindAuthenticatedConnection(channel)
    if (resync === undefined) throw new Error('expected current generation receiver')
    resync.acceptValidatedDesktopResync(projection('session-one', 'One'))
    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected current generation result receiver')

    surface.attach('session-one', selectedFile())
    expect(() => { surface.attach('session-one', selectedFile()) })
      .toThrow('Attachment operation attachment-old must be resolved before selecting another file')
    expect(channel.mutations.attach).toHaveBeenCalledOnce()
    results.acceptValidatedCompanionResult({
      type: 'attachment-rejected',
      operationId: parseCompanionOperationId('attachment-old'),
      reason: 'expired',
    })

    surface.attach('session-one', selectedFile())
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-new', status: 'sending',
    })
    results.acceptValidatedCompanionResult({
      type: 'confirmed',
      operationId: parseCompanionOperationId('attachment-old'),
      committedAt: 1,
      outcome: 'accepted',
    })
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-new', status: 'sending',
    })
    results.acceptValidatedCompanionResult({
      type: 'confirmed',
      operationId: parseCompanionOperationId('attachment-new'),
      committedAt: 2,
      outcome: 'accepted',
    })
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-new', status: 'accepted',
    })
  })

  it('requires an uncertain attachment receipt to reconcile before another file starts', async () => {
    const runtime = connectedRuntime()
    let rejectCompletion: ((reason: unknown) => void) | undefined
    const channel = connectionChannel()
    channel.mutations.attach
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-uncertain'),
        completion: new Promise<void>((_resolve, reject) => { rejectCompletion = reject }),
      })
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-after-reconcile'),
        completion: new Promise<void>(() => {}),
      })
    const surface = new MobileCompanionSurface(runtime)
    const resync = surface.bindAuthenticatedConnection(channel)
    if (resync === undefined) throw new Error('expected current generation receiver')
    resync.acceptValidatedDesktopResync(projection('session-one', 'One'))
    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected current generation result receiver')

    surface.attach('session-one', selectedFile())
    rejectCompletion?.(new CompanionAttachmentDeliveryUncertainError(
      parseCompanionOperationId('attachment-uncertain'),
      new Error('connection replaced'),
    ))
    await Promise.resolve()

    expect(() => { surface.attach('session-one', selectedFile()) })
      .toThrow('Attachment operation attachment-uncertain must be resolved before selecting another file')
    expect(channel.mutations.attach).toHaveBeenCalledOnce()
    results.acceptValidatedCompanionResult({
      type: 'status',
      operationId: parseCompanionOperationId('attachment-uncertain'),
      absent: true,
    })
    surface.attach('session-one', selectedFile())
    expect(channel.mutations.attach).toHaveBeenCalledTimes(2)
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-after-reconcile', status: 'sending',
    })
  })

  it('rejects decoded search results from a replaced connection generation', () => {
    const runtime = connectedRuntime()
    const surface = new MobileCompanionSurface(runtime)
    const firstResync = surface.bindAuthenticatedConnection(connectionChannel())
    if (firstResync === undefined) throw new Error('expected first generation receiver')
    firstResync.acceptValidatedDesktopResync(projection('session-one', 'One'))
    const firstResults = surface.bindValidatedCompanionResults()
    if (firstResults === undefined) throw new Error('expected first generation result receiver')
    surface.search('needle')

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    const replacementResync = surface.bindAuthenticatedConnection(connectionChannel())
    if (replacementResync === undefined) throw new Error('expected replacement generation receiver')
    replacementResync.acceptValidatedDesktopResync(projection('session-two', 'Two'))
    const replacementResults = surface.bindValidatedCompanionResults()
    if (replacementResults === undefined) throw new Error('expected replacement generation result receiver')
    surface.search('replacement')

    firstResults.acceptValidatedCompanionResult({
      type: 'session-search',
      operationId: parseCompanionOperationId('search-needle'),
      items: [{ sessionId: parseCompanionSessionId('stale-hit'), snippet: 'stale decoder result' }],
      hasMore: false,
    })
    expect(surface.getSnapshot().search).toEqual({
      query: 'replacement', status: 'loading', items: [], hasMore: false,
    })

    replacementResults.acceptValidatedCompanionResult({
      type: 'session-search',
      operationId: parseCompanionOperationId('search-needle'),
      items: [{ sessionId: parseCompanionSessionId('current-hit'), snippet: 'current decoder result' }],
      hasMore: false,
    })
    expect(surface.getSnapshot().search).toEqual({
      query: 'replacement',
      status: 'ready',
      items: [{ sessionId: 'current-hit', snippet: 'current decoder result' }],
      hasMore: false,
    })
  })
})

function connectedRuntime(): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure(grant)
  runtime.markConnectionOpen()
  return runtime
}

function connectionChannel(options?: {
  attachmentOperationId?: string
  attachmentCompletion?: Promise<void>
}) {
  const mutations = {
    create: vi.fn<MobileCompanionConnectionChannel['mutations']['create']>(),
    submit: vi.fn<MobileCompanionConnectionChannel['mutations']['submit']>(() => ({
      operationId: parseCompanionOperationId('submit-default'), completion: Promise.resolve(),
    })),
    cancel: vi.fn<MobileCompanionConnectionChannel['mutations']['cancel']>(() => (
      parseCompanionOperationId('cancel-default')
    )),
    attach: vi.fn<MobileCompanionConnectionChannel['mutations']['attach']>(() => ({
      operationId: parseCompanionOperationId(options?.attachmentOperationId ?? 'attachment-default'),
      completion: options?.attachmentCompletion ?? Promise.resolve(),
    })),
    search: vi.fn<MobileCompanionConnectionChannel['mutations']['search']>(() => (
      parseCompanionOperationId('search-needle')
    )),
    loadOlder: vi.fn<MobileCompanionConnectionChannel['mutations']['loadOlder']>(() => (
      parseCompanionOperationId('history-default')
    )),
    settle: vi.fn<MobileCompanionConnectionChannel['mutations']['settle']>(),
  }
  return {
    mutations,
    content: { loadImage: vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=') },
  } satisfies MobileCompanionConnectionChannel
}

function projection(id: string, title: string, pending = false): ValidatedDesktopSurfaceResync {
  return {
    type: 'desktop-resync',
    version: 1,
    authenticated: true,
    desktopName: `${title} Desktop`,
    sessions: {
      ids: [id],
      byId: {
        [id]: { id, title, displayTitle: title, running: pending, blank: false, updatedAt: 1 },
      },
      current: null,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: null,
    },
    workspaces: [],
    conversations: [{
      sessionId: id,
      nodes: [],
      turnTimings: [],
      turnEnds: [],
      partial: null,
      runningCalls: [],
      pending: pending
        ? [{
          kind: 'approval', interactionId: 'approval-rpc', sessionId: id,
          payload: { approvalId: 'approval-id' as never, toolName: 'write', reason: 'Allow write' },
        }, {
          kind: 'question', interactionId: 'question-rpc', sessionId: id,
          payload: { questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }] },
        }]
        : [],
      queue: [],
      running: pending,
      subagent: null,
      composerPhase: 'active',
      removed: false,
      openState: 'open',
      openError: null,
      hasMore: true,
      loadingOlder: false,
      promptError: null,
      blank: false,
      lastAgentError: null,
    }],
  }
}

function selectedFile(): File {
  return { name: 'notes.txt', arrayBuffer: async () => new ArrayBuffer(0) } as File
}
