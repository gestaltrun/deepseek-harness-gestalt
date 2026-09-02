/**
 * Durable-document validation decisions: parse accepts exactly the recorded
 * shape, so every recorded rejection and every accepted spelling — populated
 * tags, each settled invitation state, bounded epochs — is exercised against
 * a real document.
 */

import { describe, expect, it } from 'vitest'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { ProjectRole } from '@deepseek-ai/dsh-project-membership'
import {
  parse,
  serialize,
  type PersistedInvitation,
  type PersistedMembership,
  type PersistedProject,
  type PersistedState,
} from '../src/persisted-state.ts'

const alice = 'parse-alice' as PlatformAccountId
const bob = 'parse-bob' as PlatformAccountId

function validState(): PersistedState {
  return {
    formatVersion: 1,
    projects: [{ id: 'project-p1', name: 'P1', boundRemoteUrl: 'https://org.example/p1', createdAt: 1, rosterVersion: 0 }],
    memberships: [{
      id: 'membership-owner',
      projectId: 'project-p1',
      accountId: alice,
      role: 'owner',
      tags: ['on-call', 'db'],
      joinedAt: 2,
    }],
    invitations: [
      { id: 'invitation-accepted', projectId: 'project-p1', inviterAccountId: alice, inviteeAccountId: bob, state: 'accepted', grantedRole: 'admin', invitedAt: 3, settledAt: 4 },
      { id: 'invitation-declined', projectId: 'project-p1', inviterAccountId: alice, inviteeAccountId: bob, state: 'declined', grantedRole: 'member', invitedAt: 5, settledAt: 6 },
      { id: 'invitation-retracted', projectId: 'project-p1', inviterAccountId: alice, inviteeAccountId: bob, state: 'retracted', grantedRole: 'member', invitedAt: 7 },
    ],
  }
}

function withProject(patch: Partial<PersistedProject>): PersistedState {
  const state = validState()
  return { ...state, projects: [{ ...state.projects[0]!, ...patch }] }
}

function withMembership(patch: Partial<PersistedMembership>): PersistedState {
  const state = validState()
  return { ...state, memberships: [{ ...state.memberships[0]!, ...patch }] }
}

function withInvitation(patch: Partial<PersistedInvitation>): PersistedState {
  const state = validState()
  return { ...state, invitations: [{ ...state.invitations[0]!, ...patch }] }
}

describe('durable document validation', () => {
  it('accepts a fully populated document with tags and every invitation state', () => {
    const state = parse(serialize(validState()))
    expect(state.memberships[0]?.tags).toEqual(['on-call', 'db'])
    expect(state.invitations.map(row => row.state)).toEqual(['accepted', 'declined', 'retracted'])
    expect(state.invitations.map(row => row.grantedRole)).toEqual(['admin', 'member', 'member'])
    expect(state.invitations[0]?.settledAt).toBe(4)
    expect(state.invitations[2]?.settledAt).toBeUndefined()
  })

  it.each([
    'guest',
    null,
    42,
  ])('rejects a membership role %j outside owner|admin|member', (role) => {
    const state = withMembership({ role: role as ProjectRole })
    expect(() => parse(serialize(state))).toThrow('is outside owner|admin|member')
  })

  /** Each deviant tag corpus and the recorded rejection it must produce. */
  const invalidTags: ReadonlyArray<[unknown, string]> = [
    ['on-call', 'must be an array'],
    [[''], 'must be non-blank strings'],
    [[' padded'], 'must be non-blank strings'],
    [[3], 'must be non-blank strings'],
    [['repeat', 'repeat'], 'contain duplicates'],
  ]

  it.each(invalidTags)('rejects tags %j', (tags, message) => {
    const state = withMembership({ tags: tags as PersistedMembership['tags'] })
    expect(() => parse(serialize(state))).toThrow(`durable state tags ${message}`)
  })

  it.each([
    'createdAt',
    'rosterVersion',
  ] as const)('rejects a negative %s epoch', (key) => {
    const state = withProject({ [key]: -1 })
    expect(() => parse(serialize(state))).toThrow(`durable state ${key} must be a safe integer >= 0`)
  })

  it('rejects a negative joinedAt epoch', () => {
    const state = withMembership({ joinedAt: -1 })
    expect(() => parse(serialize(state))).toThrow('durable state joinedAt must be a safe integer >= 0')
  })

  it.each([
    'owner',
    'guest',
    null,
  ])('rejects an invitation grantedRole %j outside admin|member', (grantedRole) => {
    const state = withInvitation({ grantedRole: grantedRole as never })
    expect(() => parse(serialize(state))).toThrow('is outside admin|member')
  })

  it('rejects an invitation state outside the recorded vocabulary', () => {
    const state = withInvitation({ state: 'expired' as never })
    expect(() => parse(serialize(state))).toThrow('invitation state "expired" is unknown')
  })

  it('rejects a settledAt that is defined but not a safe integer', () => {
    const state = withInvitation({ settledAt: 1.5 })
    expect(() => parse(serialize(state))).toThrow('durable state settledAt must be undefined or a safe integer epoch')
  })

  it('rejects a foreign formatVersion', () => {
    // serialize() always stamps the current version, so the foreign one is written directly.
    const document = JSON.parse(serialize(validState())) as Record<string, unknown>
    document.formatVersion = 0
    expect(() => parse(JSON.stringify(document))).toThrow('formatVersion 0 is not supported')
  })

  it('rejects a document that is not valid JSON', () => {
    expect(() => parse('{not json')).toThrow('durable state is not valid JSON')
  })

  it.each(['42', 'null', '[]'])('rejects a document body %s that is not an object', (body) => {
    expect(() => parse(body)).toThrow('durable state document must be an object')
  })

  it('rejects a row collection that is not an array', () => {
    const document = JSON.parse(serialize(validState())) as Record<string, unknown>
    document.projects = {}
    expect(() => parse(JSON.stringify(document))).toThrow('durable state projects must be an array')
  })

  it('rejects a project row missing a required string field', () => {
    const document = JSON.parse(serialize(validState())) as { projects: Array<Record<string, unknown>> }
    delete document.projects[0]!.id
    expect(() => parse(JSON.stringify(document))).toThrow('durable state row is missing non-empty string id')
  })

  it('rejects a link normalizedRemoteUrl that is neither undefined nor a non-empty string', () => {
    const document = JSON.parse(serialize(validState())) as {
      memberships: Array<{ link?: { workspaceName: string; normalizedRemoteUrl?: unknown } }>
    }
    document.memberships[0]!.link = { workspaceName: 'w', normalizedRemoteUrl: 42 }
    expect(() => parse(JSON.stringify(document)))
      .toThrow('durable state normalizedRemoteUrl must be undefined or a non-empty string')
  })
})
