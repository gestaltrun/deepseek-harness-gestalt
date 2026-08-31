/**
 * In-memory Project Membership provider for the project-members demo
 * composition: one seeded project answers `project_members` reads, while every
 * mutation refuses — the example exercises the seam's read face only, and the
 * read-only `project_members` tool can never reach the refusing operations.
 * @module examples/project-members/memory-membership
 */

import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  ProjectMembershipError,
  ProjectMembershipService,
  type FunctionTag,
  type MemberView,
  type MembershipId,
  type ProjectId,
  type ProjectView,
  type RosterView,
} from '@deepseek-ai/dsh-project-membership'

/** The one demo project the in-memory store serves. */
const PROJECT: ProjectView = {
  id: 'proj-demo' as ProjectId,
  name: 'demo',
  boundRemoteUrl: 'https://github.com/example/demo.git',
  createdAt: 1_756_000_000_000,
}

/** The seeded roster the in-memory store serves in join order. */
const MEMBERS: readonly MemberView[] = [
  {
    id: 'mem-0' as MembershipId,
    accountId: 'acc-demo-owner' as PlatformAccountId,
    role: 'owner',
    tags: ['founding'] as FunctionTag[],
    joinedAt: 1_756_000_100_000,
  },
  {
    id: 'mem-1' as MembershipId,
    accountId: 'acc-demo-dev' as PlatformAccountId,
    role: 'member',
    tags: ['review'] as FunctionTag[],
    joinedAt: 1_756_000_200_000,
  },
]

/** Serve the demo roster from memory; mutations refuse. */
export default class MemoryProjectMembership extends ProjectMembershipService {
  /**
   * Read the seeded roster; the caller must hold a membership in the project.
   * @param actor - account whose membership gates the read.
   * @param id - project to read.
   * @returns the complete stored roster.
   */
  override async roster(actor: PlatformAccountId, id: ProjectId): Promise<RosterView> {
    if (id !== PROJECT.id) throw new ProjectMembershipError('PROJECT_NOT_FOUND', `project ${id} does not exist`)
    if (!MEMBERS.some(member => member.accountId === actor)) {
      throw new ProjectMembershipError('NOT_A_MEMBER', `account ${actor} holds no membership in project ${id}`)
    }
    return { project: PROJECT, members: MEMBERS }
  }

  override async createProject(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async invite(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async retractInvitation(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async acceptInvitation(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async declineInvitation(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async changeRole(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async setMemberTags(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async removeMember(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async pendingInvitationsFor(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async pendingInvitationContextsFor(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async pendingInvitationsIssuedBy(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async projectByRemote(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }

  override async rosterVersion(): Promise<never> {
    throw new Error('the demo membership provider serves reads only')
  }
}
