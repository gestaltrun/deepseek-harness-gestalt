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
    formatVersion: 0,
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
      { id: 'invitation-accepted', projectId: 'project-p1', inviterAccountId: alice, inviteeAccountId: bob, state: 'accepted', invitedAt: 3, settledAt: 4 },
      { id: 'invitation-declined', projectId: 'project-p1', inviterAccountId: alice, inviteeAccountId: bob, state: 'declined', invitedAt: 5, settledAt: 6 },
      { id: 'invitation-retracted', projectId: 'project-p1', inviterAccountId: alice, inviteeAccountId: bob, state: 'retracted', invitedAt: 7 },
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

  it('rejects an invitation state outside the recorded vocabulary', () => {
    const state = withInvitation({ state: 'expired' as never })
    expect(() => parse(serialize(state))).toThrow('invitation state "expired" is unknown')
  })

  it('rejects a settledAt that is defined but not a safe integer', () => {
    const state = withInvitation({ settledAt: 1.5 })
    expect(() => parse(serialize(state))).toThrow('durable state settledAt must be undefined or a safe integer epoch')
  })
})
