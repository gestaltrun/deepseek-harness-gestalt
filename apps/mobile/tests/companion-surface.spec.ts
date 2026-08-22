import { describe, expect, it, vi } from 'vitest'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
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
    })
    expect(() => { surface.create({}) }).toThrow('requires foreground synchronization')
    expect(() => { surface.submit('session-first', 'continue') }).toThrow('requires foreground synchronization')
    expect(() => { surface.cancel('session-first') }).toThrow('requires foreground synchronization')
    expect(() => { surface.attach('session-first') }).toThrow('requires foreground synchronization')
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
    surface.attach('session-one')
    const interaction = { operationId: 'question', kind: 'ask-user' as const, summary: 'Continue?', authorized: ['A'] }
    surface.settle(interaction)

    expect(mutations.create).toHaveBeenCalledWith({ workspace: 'Work' })
    expect(mutations.submit).toHaveBeenCalledWith('session-one', 'continue')
    expect(mutations.cancel).toHaveBeenCalledWith('session-one')
    expect(mutations.attach).toHaveBeenCalledWith('session-one')
    expect(mutations.settle).toHaveBeenCalledWith(interaction)
  })
})

function mutationChannel() {
  return {
    create: vi.fn(),
    submit: vi.fn(),
    cancel: vi.fn(),
    attach: vi.fn(),
    settle: vi.fn(),
  }
}
