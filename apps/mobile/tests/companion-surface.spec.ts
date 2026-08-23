import { describe, expect, it, vi } from 'vitest'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionAttachmentDeliveryUncertainError } from '../src/companion-attachment.ts'
import { CompanionForegroundRuntime } from '../src/companion-lifecycle.ts'
import { MobileCompanionSurface } from '../src/companion-surface.ts'

const grant = {
  routeId: parseRelayRouteId('route-surface'),
  endpoint: 'mobile' as const,
  credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
  revision: 1,
}

describe('MobileCompanionSurface', () => {
  it('does not project a stale generation or transmit any mutation before its replacement resync', () => {
    const runtime = new CompanionForegroundRuntime()
    const mutations = mutationChannel()
    const surface = new MobileCompanionSurface(runtime, mutations)
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const first = surface.bindValidatedDesktopResync()
    if (first === undefined) throw new Error('expected Desktop resync receiver')
    first.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Authenticated Desktop',
      sessions: [{ id: 'session-first', title: 'First', summary: 'Authenticated' }],
      streaming: false,
    })

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    first.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Stale Desktop',
      sessions: [{ id: 'session-stale', title: 'Stale', summary: 'Rejected' }],
      streaming: true,
    })

    expect(surface.getSnapshot()).toEqual({
      desktopName: 'Authenticated Desktop',
      sessions: [{ id: 'session-first', title: 'First', summary: 'Authenticated' }],
      streaming: false,
      search: { query: '', status: 'idle', items: [], hasMore: false },
      attachment: { status: 'idle' },
    })
    expect(() => { surface.create({}) }).toThrow('requires foreground synchronization')
    expect(() => { surface.submit('session-first', 'continue') }).toThrow('requires foreground synchronization')
    expect(() => { surface.cancel('session-first') }).toThrow('requires foreground synchronization')
    expect(() => { surface.attach('session-first', selectedFile()) }).toThrow('requires foreground synchronization')
    expect(() => { surface.search('needle') }).toThrow('requires foreground synchronization')
    expect(() => {
      surface.settle({ operationId: 'approval', kind: 'approval', summary: 'write', authorized: ['once'] })
    }).toThrow('requires foreground synchronization')
    expect(Object.values(mutations).every(mock => mock.mock.calls.length === 0)).toBe(true)
  })

  it('routes mutations only after the current generation accepts its validated projection', () => {
    const runtime = new CompanionForegroundRuntime()
    const mutations = mutationChannel()
    const surface = new MobileCompanionSurface(runtime, mutations)
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = surface.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Authenticated Desktop', sessions: [], streaming: false,
    })

    surface.create({ workspace: 'Work' })
    surface.submit('session-one', 'continue')
    surface.cancel('session-one')
    const file = selectedFile()
    surface.attach('session-one', file)
    surface.search('needle')
    const interaction = { operationId: 'question', kind: 'ask-user' as const, summary: 'Continue?', authorized: ['A'] }
    surface.settle(interaction)

    expect(mutations.create).toHaveBeenCalledWith({ workspace: 'Work' })
    expect(mutations.submit).toHaveBeenCalledWith('session-one', 'continue')
    expect(mutations.cancel).toHaveBeenCalledWith('session-one')
    expect(mutations.attach).toHaveBeenCalledWith('session-one', file)
    expect(mutations.search).toHaveBeenCalledWith('needle')
    expect(mutations.settle).toHaveBeenCalledWith(interaction)
  })

  it('projects only Desktop-authoritative search hits and stable Host failures', () => {
    const runtime = new CompanionForegroundRuntime()
    const surface = new MobileCompanionSurface(runtime, mutationChannel())
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = surface.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop',
      sessions: [
        { id: 'session-hit', title: 'Indexed', summary: 'metadata does not contain query' },
        { id: 'session-local-only', title: 'needle in title', summary: 'must not be searched locally' },
      ],
      streaming: false,
    })
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

  it('correlates attachment rejection, Host failure, and uncertain delivery instead of discarding them', async () => {
    const runtime = new CompanionForegroundRuntime()
    let rejectCompletion: ((reason: unknown) => void) | undefined
    const completion = new Promise<void>((_resolve, reject) => { rejectCompletion = reject })
    const mutations = mutationChannel({
      attachmentOperationId: 'attachment-visible',
      attachmentCompletion: completion,
    })
    const surface = new MobileCompanionSurface(runtime, mutations)
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = surface.bindValidatedDesktopResync()
    const results = surface.bindValidatedCompanionResults()
    if (resync === undefined || results === undefined) throw new Error('expected current generation receivers')
    resync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop', sessions: [], streaming: false,
    })

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
    const runtime = new CompanionForegroundRuntime()
    const mutations = mutationChannel()
    mutations.attach
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-old'),
        completion: new Promise<void>(() => {}),
      })
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-new'),
        completion: new Promise<void>(() => {}),
      })
    const surface = new MobileCompanionSurface(runtime, mutations)
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = surface.bindValidatedDesktopResync()
    const results = surface.bindValidatedCompanionResults()
    if (resync === undefined || results === undefined) throw new Error('expected current generation receivers')
    resync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop', sessions: [], streaming: false,
    })

    surface.attach('session-one', selectedFile())
    expect(() => { surface.attach('session-one', selectedFile()) })
      .toThrow('Attachment operation attachment-old must be resolved before selecting another file')
    expect(mutations.attach).toHaveBeenCalledOnce()
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
    const runtime = new CompanionForegroundRuntime()
    let rejectCompletion: ((reason: unknown) => void) | undefined
    const mutations = mutationChannel()
    mutations.attach
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-uncertain'),
        completion: new Promise<void>((_resolve, reject) => { rejectCompletion = reject }),
      })
      .mockReturnValueOnce({
        operationId: parseCompanionOperationId('attachment-after-reconcile'),
        completion: new Promise<void>(() => {}),
      })
    const surface = new MobileCompanionSurface(runtime, mutations)
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const resync = surface.bindValidatedDesktopResync()
    const results = surface.bindValidatedCompanionResults()
    if (resync === undefined || results === undefined) throw new Error('expected current generation receivers')
    resync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop', sessions: [], streaming: false,
    })

    surface.attach('session-one', selectedFile())
    rejectCompletion?.(new CompanionAttachmentDeliveryUncertainError(
      parseCompanionOperationId('attachment-uncertain'),
      new Error('connection replaced'),
    ))
    await Promise.resolve()

    expect(() => { surface.attach('session-one', selectedFile()) })
      .toThrow('Attachment operation attachment-uncertain must be resolved before selecting another file')
    expect(mutations.attach).toHaveBeenCalledOnce()
    results.acceptValidatedCompanionResult({
      type: 'status',
      operationId: parseCompanionOperationId('attachment-uncertain'),
      absent: true,
    })
    surface.attach('session-one', selectedFile())
    expect(mutations.attach).toHaveBeenCalledTimes(2)
    expect(surface.getSnapshot().attachment).toEqual({
      operationId: 'attachment-after-reconcile', status: 'sending',
    })
  })

  it('rejects decoded search results from a replaced connection generation', () => {
    const runtime = new CompanionForegroundRuntime()
    const surface = new MobileCompanionSurface(runtime, mutationChannel())
    runtime.configure(grant)
    runtime.markConnectionOpen()
    const firstResync = surface.bindValidatedDesktopResync()
    const firstResults = surface.bindValidatedCompanionResults()
    if (firstResync === undefined || firstResults === undefined) throw new Error('expected first generation receivers')
    firstResync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop', sessions: [], streaming: false,
    })
    surface.search('needle')

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    const replacementResync = surface.bindValidatedDesktopResync()
    const replacementResults = surface.bindValidatedCompanionResults()
    if (replacementResync === undefined || replacementResults === undefined) {
      throw new Error('expected replacement generation receivers')
    }
    replacementResync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop', sessions: [], streaming: false,
    })
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

function mutationChannel(options?: {
  attachmentOperationId?: string
  attachmentCompletion?: Promise<void>
}) {
  return {
    create: vi.fn(),
    submit: vi.fn(),
    cancel: vi.fn(),
    attach: vi.fn(() => ({
      operationId: parseCompanionOperationId(options?.attachmentOperationId ?? 'attachment-default'),
      completion: options?.attachmentCompletion ?? Promise.resolve(),
    })),
    search: vi.fn(() => parseCompanionOperationId('search-needle')),
    settle: vi.fn(),
  }
}

function selectedFile(): File {
  return { name: 'notes.txt', arrayBuffer: async () => new ArrayBuffer(0) } as File
}
