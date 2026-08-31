/**
 * Load-path referential integrity: a durable document whose membership or
 * invitation rows reference a project the document does not define is
 * corruption. Loading it fails loud with the offending row and project
 * identifiers, and the store refuses every later operation with that same
 * error instead of half-assembling a zombie corpus.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { InvitationId, ProjectId } from '@deepseek-ai/dsh-project-membership'
import { FileProjectMembership } from '../src/index.ts'
import { parse, serialize, type PersistedState } from '../src/persisted-state.ts'

const alice = 'dangling-alice' as PlatformAccountId

const REAL_PROJECT_ID = 'project-real'
const DANGLING_PROJECT_ID = 'project-ghost'

const realProject = {
  id: REAL_PROJECT_ID,
  name: 'Real',
  boundRemoteUrl: 'https://org.example/real',
  createdAt: 1,
  rosterVersion: 0,
}

const ghostProject = {
  id: DANGLING_PROJECT_ID,
  name: 'Ghost Now Real',
  boundRemoteUrl: 'https://org.example/ghost',
  createdAt: 2,
  rosterVersion: 0,
}

/** Valid shape, but its membership row names a project the document omits. */
function stateWithDanglingMembership(): PersistedState {
  return {
    formatVersion: 0,
    projects: [realProject],
    memberships: [{
      id: 'membership-owner',
      projectId: DANGLING_PROJECT_ID,
      accountId: alice,
      role: 'owner',
      tags: [],
      joinedAt: 1,
    }],
    invitations: [],
  }
}

/** Valid shape, but its invitation row names a project the document omits. */
function stateWithDanglingInvitation(): PersistedState {
  return {
    formatVersion: 0,
    projects: [realProject],
    memberships: [],
    invitations: [{
      id: 'invitation-ghost-target',
      projectId: DANGLING_PROJECT_ID,
      inviterAccountId: alice,
      inviteeAccountId: 'dangling-bob',
      state: 'pending',
      invitedAt: 1,
    }],
  }
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  contexts.length = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('durable documents with dangling project references are corruption', () => {
  it('rejects at parse a membership row naming an unknown project, identifying both ids', () => {
    expect(() => parse(serialize(stateWithDanglingMembership()))).toThrow(
      `project-membership: durable state membership membership-owner references unknown project ${DANGLING_PROJECT_ID}`,
    )
  })

  it('rejects at parse an invitation row naming an unknown project, identifying both ids', () => {
    expect(() => parse(serialize(stateWithDanglingInvitation()))).toThrow(
      `project-membership: durable state invitation invitation-ghost-target references unknown project ${DANGLING_PROJECT_ID}`,
    )
  })

  it('accepts the same rows once the referenced project is part of the document', () => {
    const state = stateWithDanglingMembership()
    const repaired: PersistedState = { ...state, projects: [realProject, ghostProject] }
    expect(parse(serialize(repaired)).projects.map(project => project.id).sort())
      .toEqual([DANGLING_PROJECT_ID, REAL_PROJECT_ID].sort())
  })
})

describe('a store booting over a dangling document refuses every operation', () => {
  it.each([
    [
      'name',
      { ...ghostProject, name: realProject.name },
      'durable state contains duplicate project name',
    ],
    [
      'remote',
      { ...ghostProject, boundRemoteUrl: realProject.boundRemoteUrl },
      'durable state contains duplicate project remote',
    ],
  ])('rejects duplicate project %s indexes while loading', async (_kind, duplicateProject, message) => {
    const root = await rootedState({
      formatVersion: 0,
      projects: [realProject, duplicateProject],
      memberships: [],
      invitations: [],
    })
    const store = makeStoreAt(root)
    await expect(store.pendingInvitationsFor(alice)).rejects.toThrow(message)
  })

  it('rejects reads and writes with the membership corruption error naming row and project', async () => {
    const root = await rootedState(stateWithDanglingMembership())
    const store = makeStoreAt(root)
    await expect(store.roster(alice, REAL_PROJECT_ID as ProjectId)).rejects.toThrow(
      `project-membership: durable state membership membership-owner references unknown project ${DANGLING_PROJECT_ID}`,
    )
    await expect(store.pendingInvitationsFor(alice)).rejects.toThrow(DANGLING_PROJECT_ID)
    // Nothing was half-assembled: a mutation cannot republish an empty corpus over the document.
    await expect(store.createProject(alice, { name: 'After Crash', remoteUrl: 'https://org.example/after' }))
      .rejects.toThrow(`unknown project ${DANGLING_PROJECT_ID}`)
    const document = JSON.parse(await readFile(join(root, 'development', 'project-membership.json'), 'utf8')) as {
      projects: Array<{ id: string }>
    }
    expect(document.projects.map(project => project.id)).toEqual([REAL_PROJECT_ID])
  })

  it('rejects operations with the invitation corruption error when only an invitation dangles', async () => {
    const root = await rootedState(stateWithDanglingInvitation())
    const store = makeStoreAt(root)
    await expect(store.pendingInvitationsFor('dangling-bob' as PlatformAccountId)).rejects.toThrow(
      `project-membership: durable state invitation invitation-ghost-target references unknown project ${DANGLING_PROJECT_ID}`,
    )
  })

  it('refuses to accept an invitation whose invitee the same document already lists as a member', async () => {
    const state: PersistedState = {
      formatVersion: 0,
      projects: [realProject],
      memberships: [{
        id: 'membership-dup',
        projectId: REAL_PROJECT_ID,
        accountId: 'dangling-bob',
        role: 'member',
        tags: [],
        joinedAt: 1,
      }],
      invitations: [{
        id: 'invitation-stale-pending',
        projectId: REAL_PROJECT_ID,
        inviterAccountId: alice,
        inviteeAccountId: 'dangling-bob',
        state: 'pending',
        invitedAt: 2,
      }],
    }
    const root = await rootedState(state)
    const store = makeStoreAt(root)
    await expect(store.acceptInvitation('dangling-bob' as PlatformAccountId, {
      invitationId: 'invitation-stale-pending' as InvitationId,
      link: { workspaceName: 'late-checkout' },
    })).rejects.toMatchObject({ code: 'DUPLICATE_INVITEE' })
  })

  /**
   * Write one document to a fresh environment root.
   * @param state - the durable document to store.
   * @returns the storage path holding `development/project-membership.json`.
   */
  async function rootedState(state: PersistedState): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-dangling-'))
    roots.push(root)
    const directory = join(root, 'development')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'project-membership.json'), serialize(state))
    return root
  }

  function makeStoreAt(storagePath: string): FileProjectMembership {
    const context = new Context()
    contexts.push(context)
    return new FileProjectMembership(context, { storagePath, environment: 'development' })
  }
})
