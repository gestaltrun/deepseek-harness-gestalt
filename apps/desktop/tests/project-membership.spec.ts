import { describe, expect, it, vi } from 'vitest'
import type { SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import {
  createDesktopProjectMembershipClient,
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
    expect(parseProjectInvitation({ projectId: 'project-1', githubLogin: ' mona ' }))
      .toEqual({ projectId: 'project-1', githubLogin: 'mona' })
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
})
