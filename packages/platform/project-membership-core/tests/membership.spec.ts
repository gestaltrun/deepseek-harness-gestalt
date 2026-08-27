/**
 * Executor-level behavior for the file-backed Project Membership provider:
 * atomic invite/accept under concurrency, role gates enforced inside each
 * operation, tag-edit authority, LAST_OWNER protection, durable
 * environment-namespaced persistence, and roster projection invalidation.
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  normalizeGitRemoteUrl,
  ProjectMembershipError,
  type FunctionTag,
  type InvitationId,
  type MemberView,
  type ProjectId,
  type RosterInvalidation,
} from '@deepseek-ai/dsh-project-membership'
import { FileProjectMembership } from '../src/index.ts'

const alice = 'account-alice' as PlatformAccountId
const bob = 'account-bob' as PlatformAccountId
const carol = 'account-carol' as PlatformAccountId
const dave = 'account-dave' as PlatformAccountId

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  contexts.length = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function freshRoot(): string {
  const root = join(tmpdir(), `dsh-project-membership-${Math.random().toString(36).slice(2)}-`)
  roots.push(root)
  return root
}

function makeStoreAt(storagePath: string, environment: 'development' | 'production'): FileProjectMembership {
  const context = new Context()
  contexts.push(context)
  return new FileProjectMembership(context, { storagePath, environment })
}

async function foundProject(
  actor: PlatformAccountId,
  name: string,
): Promise<{ store: FileProjectMembership; projectId: ProjectId }> {
  const store = makeStoreAt(freshRoot(), 'development')
  const view = await store.createProject(actor, { name, remoteUrl: 'git@github.com:Org/repo.git' })
  return { store, projectId: view.id }
}

async function joinWith(
  store: FileProjectMembership,
  projectId: ProjectId,
  invitee: PlatformAccountId,
  workspaceName: string,
): Promise<MemberView> {
  await store.invite(alice, { projectId, inviteeAccountId: invitee })
  const pending = await store.pendingInvitationsFor(invitee)
  const invitation: InvitationId = pending.at(-1)!.id
  return store.acceptInvitation(invitee, { invitationId: invitation, link: { workspaceName } })
}

async function ownMembershipOf(
  store: FileProjectMembership,
  actor: PlatformAccountId,
  projectId: ProjectId,
): Promise<MemberView> {
  const roster = await store.roster(actor, projectId)
  const found = roster.members.find(row => row.accountId === actor)
  expect(found).toBeDefined()
  return found!
}

describe('file-backed project membership', () => {
  it('creates a project whose creator is the founding owner with the remote bound normalized', async () => {
    const store = makeStoreAt(freshRoot(), 'development')
    const project = await store.createProject(alice, {
      name: 'Harness',
      remoteUrl: 'HTTPS://GitHub.COM/Org/harness.git',
    })
    expect(project.boundRemoteUrl).toBe(normalizeGitRemoteUrl('https://github.com/Org/harness.git'))
    const roster = await store.roster(alice, project.id)
    expect(roster.members).toHaveLength(1)
    expect(roster.members[0]).toMatchObject({ accountId: alice, role: 'owner' })
    expect(roster.members[0]?.link).toBeUndefined()
    await expect(store.projectByRemote(alice, project.boundRemoteUrl)).resolves.toMatchObject({ id: project.id })
    await expect(store.projectByRemote(alice, 'git@github.com:Org/unrelated')).resolves.toBeUndefined()
  })

  it('rejects duplicate names atomically inside one environment but allows them across environments', async () => {
    const shared = freshRoot()
    const development = makeStoreAt(shared, 'development')
    const production = makeStoreAt(shared, 'production')
    await development.createProject(alice, { name: 'Solaris', remoteUrl: 'https://org.example/solaris' })
    await production.createProject(carol, { name: 'Solaris', remoteUrl: 'https://other.example/solaris' })
    await expect(development.createProject(bob, { name: ' Solaris ', remoteUrl: 'https://x.example/x' }))
      .rejects.toMatchObject({ code: 'PROJECT_NAME_TAKEN' })
    await expect(production.createProject(dave, { name: 'Harness', remoteUrl: 'https://x.example/y' }))
      .resolves.toMatchObject({ name: 'Harness' })
    // Development projects are invisible behind a production namespace and vice versa.
    await expect(development.projectByRemote(carol, 'https://other.example/solaris')).resolves.toBeUndefined()
    await expect(development.rosterVersion('missing-project' as ProjectId))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('settles concurrent invitations to one account into exactly one pending row', async () => {
    const { store, projectId } = await foundProject(alice, 'Race')
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
      store.invite(alice, { projectId, inviteeAccountId: bob })))
    const rejected = attempts.filter((result): result is PromiseRejectedResult<ProjectMembershipError> =>
      result.status === 'rejected')
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(rejected.every(result => result.reason.code === 'DUPLICATE_INVITEE')).toBe(true)
    expect(await store.pendingInvitationsFor(bob)).toHaveLength(1)
  })

  it('enforces the role gate through every mutating executor', async () => {
    const { store, projectId } = await foundProject(alice, 'Gates')
    const bobMember = await joinWith(store, projectId, bob, 'bob-checkout')
    const carolMember = await joinWith(store, projectId, carol, 'carol-checkout')
    const aliceMember = await ownMembershipOf(store, alice, projectId)
    await store.changeRole(alice, { membershipId: bobMember.id, role: 'admin' })
    const denial = async (run: Promise<unknown>, code: string) => {
      await expect(run).rejects.toMatchObject({ code })
    }
    // Members invite nobody; strangers see nothing at all.
    await denial(store.invite(carol, { projectId, inviteeAccountId: dave }), 'ROLE_REQUIRED')
    await denial(store.invite(dave, { projectId, inviteeAccountId: dave }), 'NOT_A_MEMBER')
    await denial(store.roster(dave, projectId), 'NOT_A_MEMBER')
    // Admins invite but every owner-facing surface answers only to owners.
    await denial(store.changeRole(bob, { membershipId: aliceMember.id, role: 'admin' }), 'ROLE_REQUIRED')
    await denial(store.changeRole(bob, { membershipId: bobMember.id, role: 'owner' }), 'ROLE_REQUIRED')
    await denial(store.removeMember(bob, aliceMember.id), 'ROLE_REQUIRED')
    await denial(store.setMemberTags(carol, {
      membershipId: carolMember.id,
      tags: ['backend' as FunctionTag],
    }), 'ROLE_REQUIRED')
    await denial(store.removeMember(alice, 'no-such-row' as never), 'MEMBERSHIP_NOT_FOUND')
    // An owner hands out ownership; the new owner row likewise exits admin reach.
    await store.changeRole(alice, { membershipId: carolMember.id, role: 'owner' })
    await denial(store.changeRole(bob, { membershipId: carolMember.id, role: 'admin' }), 'ROLE_REQUIRED')
    // With two owners present, one owner may step down; plain-member rows stay under admin authority.
    await store.changeRole(alice, { membershipId: aliceMember.id, role: 'admin' })
  })

  it('protects the final owner from demotion and removal', async () => {
    const { store, projectId } = await foundProject(alice, 'LastOwner')
    const aliceMember = await ownMembershipOf(store, alice, projectId)
    await expect(store.changeRole(alice, { membershipId: aliceMember.id, role: 'admin' }))
      .rejects.toMatchObject({ code: 'LAST_OWNER' })
    await expect(store.removeMember(alice, aliceMember.id))
      .rejects.toMatchObject({ code: 'LAST_OWNER' })
    const bobMember = await joinWith(store, projectId, bob, 'bob-second')
    await store.changeRole(alice, { membershipId: bobMember.id, role: 'owner' })
    await store.changeRole(alice, { membershipId: aliceMember.id, role: 'admin' })
  })

  it('commits acceptance and its workspace link atomically, leaving nothing behind on refusal paths', async () => {
    const shared = freshRoot()
    const store = makeStoreAt(shared, 'development')
    const created = await store.createProject(alice, {
      name: 'Joining',
      remoteUrl: 'git@github.com:Org/joining.git',
    })
    const projectId = created.id
    await store.invite(alice, { projectId, inviteeAccountId: bob })
    const invitation = (await store.pendingInvitationsFor(bob))[0]!.id

    // A blank workspace name rejects before any state moves.
    await expect(store.acceptInvitation(bob, { invitationId: invitation, link: { workspaceName: '   ' } }))
      .rejects.toMatchObject({ code: 'INVALID_LINK' })
    expect((await store.pendingInvitationsFor(bob)).map(row => row.state)).toEqual(['pending'])

    const joined = await store.acceptInvitation(bob, {
      invitationId: invitation,
      link: { workspaceName: 'bob-repo', normalizedRemoteUrl: 'https://github.com/bob/repo.GIT' },
    })
    expect(joined.link).toMatchObject({ workspaceName: 'bob-repo', normalizedRemoteUrl: 'https://github.com/bob/repo' })
    await expect(store.acceptInvitation(bob, { invitationId: invitation, link: { workspaceName: 'again' } }))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_PENDING' })

    // Durable outcome: a fresh store over the same directory sees the committed rows.
    const reopened = makeStoreAt(shared, 'development')
    const durableRoster = await reopened.roster(alice, projectId)
    expect(durableRoster.members.map(row => row.accountId).sort()).toEqual([alice, bob].sort())
    expect(await reopened.pendingInvitationsFor(bob)).toEqual([])

    // A declined invitation produces no membership row anywhere.
    await store.invite(alice, { projectId, inviteeAccountId: carol })
    const carolInvitation = (await store.pendingInvitationsFor(carol))[0]!.id
    await store.declineInvitation(carol, carolInvitation)
    const declinedRoster = await store.roster(alice, projectId)
    expect(declinedRoster.members.map(row => row.accountId)).not.toContain(carol)
    // Addressee identity stays private: other accounts see no such invitation.
    await expect(store.declineInvitation(alice, carolInvitation))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' })
    await expect(store.declineInvitation(alice, 'ghost' as InvitationId))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' })
  })

  it('keeps retraction issuer-or-owner scoped through the lifecycle', async () => {
    const { store, projectId } = await foundProject(alice, 'Scoping')
    await store.invite(alice, { projectId, inviteeAccountId: bob })
    const invitation = (await store.pendingInvitationsFor(bob))[0]!.id
    await expect(store.retractInvitation(carol, invitation))
      .rejects.toMatchObject({ code: 'NOT_A_MEMBER' })
    await store.retractInvitation(alice, invitation)
    expect(await store.pendingInvitationsFor(bob)).toEqual([])
    await expect(store.retractInvitation(alice, invitation))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_PENDING' })
    await expect(store.retractInvitation(alice, 'ghost' as InvitationId))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' })
  })

  it('gates function-tag edits and carries the tags through every roster view', async () => {
    const { store, projectId } = await foundProject(alice, 'Tags')
    const bobMember = await joinWith(store, projectId, bob, 'bob-tags')
    await expect(store.setMemberTags(bob, { membershipId: bobMember.id, tags: ['self-service' as FunctionTag] }))
      .rejects.toMatchObject({ code: 'ROLE_REQUIRED' })
    await expect(store.setMemberTags(alice, {
      membershipId: bobMember.id,
      tags: ['', 'x'.repeat(33), 'on-call'] as unknown as FunctionTag[],
    })).rejects.toMatchObject({ code: 'INVALID_TAGS' })
    await expect(store.setMemberTags(alice, {
      membershipId: bobMember.id,
      tags: ['on-call', 'on-call'] as FunctionTag[],
    })).rejects.toMatchObject({ code: 'INVALID_TAGS' })
    await store.setMemberTags(alice, { membershipId: bobMember.id, tags: ['on-call', 'db'] as FunctionTag[] })
    const roster = await store.roster(alice, projectId)
    expect(roster.members.find(row => row.accountId === bob)?.tags.map(tag => String(tag)))
      .toEqual(['on-call', 'db'])
  })

  it('invalidates the roster projection version on removal and drops removed accounts immediately', async () => {
    const context = new Context()
    contexts.push(context)
    const store = new FileProjectMembership(context, { storagePath: freshRoot(), environment: 'development' })
    const invalidations: RosterInvalidation[] = []
    context.on('project-membership/roster-invalidated', (change) => { invalidations.push(change) })

    const created = await store.createProject(alice, {
      name: 'Departures',
      remoteUrl: 'https://org.example/departures',
    })
    const projectId = created.id
    const bobMember = await joinWith(store, projectId, bob, 'bob-departures')
    const aliceMember = await ownMembershipOf(store, alice, projectId)
    const versionBeforeRemoval = await store.rosterVersion(projectId)
    await store.removeMember(alice, bobMember.id)

    const removalEvents = invalidations.filter(change => change.reason === 'removed')
    expect(removalEvents).toHaveLength(1)
    expect(removalEvents[0]).toMatchObject({
      accountId: bob,
      projectId,
      membershipId: bobMember.id,
      rosterVersionBefore: versionBeforeRemoval,
      rosterVersionAfter: versionBeforeRemoval + 1,
    })
    expect(await store.rosterVersion(projectId)).toBe(versionBeforeRemoval + 1)
    expect((await store.roster(alice, projectId)).members.map(row => row.accountId)).toEqual([alice])
    await expect(store.roster(bob, projectId)).rejects.toMatchObject({ code: 'NOT_A_MEMBER' })
    // Alice is the sole remaining owner, so tag edits publish the projection version too;
    // every project's published versions only ever move forward.
    const versionBeforeTags = await store.rosterVersion(projectId)
    await store.setMemberTags(alice, { membershipId: aliceMember.id, tags: ['solo'] as FunctionTag[] })
    expect(await store.rosterVersion(projectId)).toBe(versionBeforeTags + 1)
    const lastSeen = new Map<ProjectId, number>()
    for (const change of invalidations) {
      const previous = lastSeen.get(change.projectId)
      expect(change.rosterVersionAfter).toBe(change.rosterVersionBefore + 1)
      if (previous !== undefined) expect(change.rosterVersionAfter).toBeGreaterThan(previous)
      lastSeen.set(change.projectId, change.rosterVersionAfter)
    }
  })
})
