import { describe, expect, it, vi } from 'vitest'
import type { SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import {
  createDesktopProjectMembershipClient,
  createDesktopProjectMembershipPresence,
  parseInvitationDecision,
  parseMembershipRole,
  parseMembershipTags,
  parseProjectCreation,
  parseProjectInvitation,
} from '../src/project-membership.ts'

const environment = {
  origin: 'https://platform.example.test',
} as SelectedPlatformEnvironment

describe('Desktop Project Membership bridge', () => {
  it('keeps Account credentials in main and obtains a fresh proof for every operation', async () => {
    const authorizeCurrentInstallation = vi.fn()
      .mockResolvedValueOnce({
        accessToken: 'access-one',
        proof: { jti: 'proof-one', issuedAt: 1, signature: 'signature-one' },
      })
      .mockResolvedValueOnce({
        accessToken: 'access-two',
        proof: { jti: 'proof-two', issuedAt: 2, signature: 'signature-two' },
      })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'project-1', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/r', createdAt: 1,
        receivingAccountId: 'account-1',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const client = createDesktopProjectMembershipClient({
      account: () => ({ authorizeCurrentInstallation } as never),
      environment,
      fetch,
    })

    await client.createProject({ name: 'Atlas', remoteUrl: 'https://github.com/o/r' })
    await client.pendingInvitations()

    expect(authorizeCurrentInstallation).toHaveBeenCalledTimes(2)
    const firstHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    const secondHeaders = new Headers(fetch.mock.calls[1]?.[1]?.headers)
    expect(firstHeaders.get('authorization')).toBe('Bearer access-one')
    expect(firstHeaders.get('x-gestalt-proof-jti')).toBe('proof-one')
    expect(secondHeaders.get('authorization')).toBe('Bearer access-two')
    expect(secondHeaders.get('x-gestalt-proof-jti')).toBe('proof-two')
  })

  it('parses exact hostile IPC payloads before any Platform request', () => {
    expect(parseProjectCreation({ name: ' Atlas ', remoteUrl: ' https://github.com/o/r ' }))
      .toEqual({ name: 'Atlas', remoteUrl: 'https://github.com/o/r' })
    expect(parseProjectInvitation({ projectId: 'project-1', githubLogin: ' mona ', grantedRole: 'admin' }))
      .toEqual({ projectId: 'project-1', githubLogin: 'mona', grantedRole: 'admin' })
    expect(() => parseProjectInvitation({ projectId: 'project-1', githubLogin: 'mona', grantedRole: 'superadmin' }))
      .toThrow('grantedRole must be owner, admin, or member')
    expect(parseInvitationDecision({
      invitationId: 'invitation-1',
      input: {
        decision: 'accept-with-link',
        link: { workspaceName: ' local ', normalizedRemoteUrl: ' https://github.com/o/r ' },
      },
    })).toEqual({
      invitationId: 'invitation-1',
      input: {
        decision: 'accept-with-link',
        link: { workspaceName: 'local', normalizedRemoteUrl: 'https://github.com/o/r' },
      },
    })
    expect(parseMembershipRole({ membershipId: 'membership-1', role: 'admin' }))
      .toEqual({ membershipId: 'membership-1', role: 'admin' })
    expect(parseMembershipTags({ membershipId: 'membership-1', tags: [' triage '] }))
      .toEqual({ membershipId: 'membership-1', tags: ['triage'] })

    expect(() => parseProjectCreation({ name: 'Atlas', remoteUrl: 'https://github.com/o/r', token: 'leak' }))
      .toThrow('unknown field')
    expect(() => parseInvitationDecision({ invitationId: 'invitation-1', input: { decision: 'accept' } }))
      .toThrow('must be decline or accept-with-link')
    expect(() => parseMembershipRole({ membershipId: 'membership-1', role: 'superadmin' }))
      .toThrow('owner, admin, or member')
    expect(() => parseMembershipTags({ membershipId: 'membership-1', tags: 'triage' }))
      .toThrow('must be an array')
  })

  it('heartbeats while signed in and closes presence immediately on last-window close', async () => {
    const authorizeCurrentInstallation = vi.fn().mockResolvedValue({
      accessToken: 'presence-access',
      proof: { jti: 'presence-proof', issuedAt: 3, signature: 'presence-signature' },
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(undefined, { status: 204 }))
    const tasks: Array<() => void> = []
    const handles: Array<ReturnType<typeof setTimeout>> = []
    const cancelled: Array<ReturnType<typeof setTimeout>> = []
    const presence = createDesktopProjectMembershipPresence({
      account: () => ({ authorizeCurrentInstallation } as never),
      environment,
      fetch,
      intervalMs: 25,
      schedule: (task) => {
        tasks.push(task)
        const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>
        handles.push(handle)
        return handle
      },
      cancel: (handle) => { cancelled.push(handle) },
    })

    presence.setSignedIn(true)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://platform.example.test/v1/projects/presence/heartbeat')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer presence-access')
    await presence.closeWindow()
    expect(cancelled).toEqual([handles.at(-1)])
    expect(fetch.mock.calls[1]?.[0]).toBe('https://platform.example.test/v1/projects/presence/close')
    tasks.shift()?.()
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(2)
    await presence.dispose()
  })

  it('restores Online through live-connection derivation after last-window close then setSignedIn(true)', async () => {
    const authorizeCurrentInstallation = vi.fn().mockResolvedValue({
      accessToken: 'presence-access',
      proof: { jti: 'presence-proof', issuedAt: 3, signature: 'presence-signature' },
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(undefined, { status: 204 }))
    const presence = createDesktopProjectMembershipPresence({
      account: () => ({ authorizeCurrentInstallation } as never),
      environment,
      fetch,
      intervalMs: 25,
      schedule: () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>,
      cancel: () => {},
    })

    presence.setSignedIn(true)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
    await presence.closeWindow()
    expect(fetch.mock.calls[1]?.[0]).toBe('https://platform.example.test/v1/projects/presence/close')
    presence.setSignedIn(true)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(3) })
    expect(fetch.mock.calls[2]?.[0]).toBe('https://platform.example.test/v1/projects/presence/heartbeat')
    await presence.dispose()
  })

  it('does not heartbeat after last-window close aborts an in-flight authorization', async () => {
    const authorization = {
      accessToken: 'presence-access',
      proof: { jti: 'presence-proof', issuedAt: 3, signature: 'presence-signature' },
    }
    let releaseBeatAuthorize: ((value: typeof authorization) => void) | undefined
    const authorizeCurrentInstallation = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof authorization>((resolve) => {
        releaseBeatAuthorize = resolve
      }))
      .mockResolvedValue(authorization)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(undefined, { status: 204 }))
    const presence = createDesktopProjectMembershipPresence({
      account: () => ({ authorizeCurrentInstallation } as never),
      environment,
      fetch,
      intervalMs: 25,
      schedule: () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>,
      cancel: () => {},
    })

    presence.setSignedIn(true)
    await vi.waitFor(() => { expect(releaseBeatAuthorize).toBeDefined() })
    const closed = presence.closeWindow()
    releaseBeatAuthorize?.(authorization)
    await closed
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'https://platform.example.test/v1/projects/presence/close',
    ])
    await presence.dispose()
  })

  it('does not close presence when the last window leaves an unsigned-in Installation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const presence = createDesktopProjectMembershipPresence({
      account: () => ({ authorizeCurrentInstallation: vi.fn() } as never),
      environment,
      fetch,
    })
    await presence.closeWindow()
    expect(fetch).not.toHaveBeenCalled()
    await presence.dispose()
  })

  it('validates and contains the presence lifecycle boundary', async () => {
    expect(() => createDesktopProjectMembershipPresence({
      account: () => ({}) as never,
      environment,
      fetch: vi.fn(),
      intervalMs: 0,
    })).toThrow('positive safe integer')
    const onError = vi.fn()
    const presence = createDesktopProjectMembershipPresence({
      account: () => ({ authorizeCurrentInstallation: () => Promise.reject(new Error('signed out')) } as never),
      environment,
      fetch: vi.fn(),
      onError,
      schedule: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
    })
    presence.setSignedIn(true)
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledOnce() })
    await presence.dispose()
  })

  it('contains a last-window close failure without hanging', async () => {
    const authorizeCurrentInstallation = vi.fn().mockResolvedValue({
      accessToken: 'presence-access',
      proof: { jti: 'presence-proof', issuedAt: 3, signature: 'presence-signature' },
    })
    const onError = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
      .mockRejectedValueOnce(new Error('close failed'))
    const presence = createDesktopProjectMembershipPresence({
      account: () => ({ authorizeCurrentInstallation } as never),
      environment,
      fetch,
      onError,
      schedule: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
    })
    presence.setSignedIn(true)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    await presence.closeWindow()
    expect(onError).toHaveBeenCalledOnce()
    await presence.dispose()
  })
})
