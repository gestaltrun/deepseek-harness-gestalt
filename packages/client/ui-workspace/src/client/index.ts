/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook, and each declares its
 * own `single` directory-flow child hole for the composed picker package's
 * client half (see the contract module doc). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  FunctionTag, InvitationId, MembershipId, ProjectId, ProjectMembershipClient,
  PlatformAccountId,
} from '@deepseek-ai/dsh-project-membership-client'
import { normalizeGitRemoteUrl } from '@deepseek-ai/dsh-project-membership/remote-url'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  ProjectMembershipGateway, WorkspaceBrowserInjected, WorkspacePickerInjected,
} from './contract/slots.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  WorkspaceBrowserInjected, WorkspaceBrowserProps, WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'connection']

function projectMembershipGateway(
  client: ProjectMembershipClient,
  workspaces: ClientContext['workspaces'],
  connection: ConnectionHandle,
): ProjectMembershipGateway {
  const bindWorkspace = async (input: {
    receivingAccountId: PlatformAccountId
    projectId: ProjectId
    workspaceId: WorkspaceId
  }): Promise<void> => {
    const binding = await connection.api.memberQuestions.bindWorkspace({
      receivingAccountId: input.receivingAccountId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
    })
    if (!binding.result.ok) throw new Error(binding.result.error.message)
  }
  const ensureWorkspaceBinding = async (input: {
    receivingAccountId: PlatformAccountId
    projectId: ProjectId
    workspaceId: WorkspaceId
  }): Promise<WorkspaceId> => {
    const binding = await connection.api.memberQuestions.ensureWorkspaceBinding(input)
    if (!binding.result.ok) throw new Error(binding.result.error.message)
    return binding.result.value.workspaceId
  }
  return {
    createProject: async (input) => {
      const { localWorkspaceId, name } = input
      const remoteUrl = await workspaces.gitRemote(localWorkspaceId)
      if (remoteUrl === undefined) {
        throw new Error('This Workspace must be a Git checkout with an origin remote before it can become a Cloud Project.')
      }
      let normalizedRemoteUrl: string
      try {
        normalizedRemoteUrl = normalizeGitRemoteUrl(remoteUrl)
      } catch {
        throw new Error('This Workspace origin is not a supported Git remote.')
      }
      const project = await client.createProject({ name, remoteUrl: normalizedRemoteUrl })
      await bindWorkspace({
        receivingAccountId: project.receivingAccountId,
        projectId: project.id,
        workspaceId: localWorkspaceId,
      })
      return {
        id: project.id,
        name: project.name,
        boundRemoteUrl: project.boundRemoteUrl,
        receivingAccountId: project.receivingAccountId,
      }
    },
    projectForWorkspace: async (workspaceId) => {
      const remoteUrl = await workspaces.gitRemote(workspaceId)
      if (remoteUrl === undefined) return undefined
      let normalizedRemoteUrl: string
      try {
        normalizedRemoteUrl = normalizeGitRemoteUrl(remoteUrl)
      } catch {
        return undefined
      }
      const project = await client.projectByRemote(normalizedRemoteUrl)
      if (project === undefined) return undefined
      const boundWorkspaceId = await ensureWorkspaceBinding({
        receivingAccountId: project.receivingAccountId,
        projectId: project.id,
        workspaceId,
      })
      if (boundWorkspaceId !== workspaceId) {
        throw new Error(`Cloud Project "${project.name}" is already linked to another local Workspace.`)
      }
      return {
        id: project.id,
        name: project.name,
        boundRemoteUrl: project.boundRemoteUrl,
        receivingAccountId: project.receivingAccountId,
      }
    },
    roster: async (projectId) => {
      const roster = await client.roster(projectId as ProjectId)
      return {
        project: {
          id: roster.project.id,
          name: roster.project.name,
          boundRemoteUrl: roster.project.boundRemoteUrl,
        },
        members: roster.members.map(member => ({
          membershipId: member.id,
          accountId: member.accountId,
          displayName: member.displayName,
          role: member.role,
          tags: member.tags,
          presence: member.presence,
        })),
      }
    },
    invite: async ({ projectId, githubLogin, grantedRole }) => {
      const invitation = await client.invite({
        projectId: projectId as ProjectId, githubLogin, grantedRole,
      })
      return { invitationId: invitation.id, inviteeName: githubLogin, grantedRole: invitation.grantedRole }
    },
    issuedInvitations: async projectId => (await client.issuedInvitations(projectId as ProjectId))
      .map(invitation => ({
        invitationId: invitation.invitationId,
        inviteeName: invitation.inviteeName,
        grantedRole: invitation.grantedRole,
      })),
    retractInvitation: async (invitationId) => {
      await client.retractInvitation(invitationId as InvitationId)
    },
    decideInvitation: async (invitationId, input) => {
      if (input.decision === 'decline') {
        await client.decideInvitation(invitationId as InvitationId, input)
        return
      }
      await bindWorkspace({
        receivingAccountId: input.receivingAccountId as PlatformAccountId,
        projectId: input.projectId as ProjectId,
        workspaceId: input.localWorkspaceId,
      })
      await client.decideInvitation(invitationId as InvitationId, {
        decision: input.decision,
        link: input.link,
      })
    },
    changeRole: async (membershipId, role) => {
      await client.changeRole(membershipId as MembershipId, role)
    },
    setMemberTags: async (membershipId, tags) => {
      await client.setMemberTags(membershipId as MembershipId, tags as readonly FunctionTag[])
    },
    removeMember: async (membershipId) => {
      await client.removeMember(membershipId as MembershipId)
    },
    pendingInvitations: async () => (await client.pendingInvitations()).map(invitation => ({
      invitationId: invitation.invitationId,
      receivingAccountId: invitation.receivingAccountId,
      projectId: invitation.projectId,
      projectName: invitation.projectName,
      inviterName: invitation.inviterName,
      remoteUrl: invitation.remoteUrl,
      grantedRole: invitation.grantedRole,
    })),
    localRemoteFor: async (workspaceId) => {
      const remote = await workspaces.gitRemote(workspaceId)
      if (remote === undefined) return undefined
      try {
        return normalizeGitRemoteUrl(remote)
      } catch {
        return undefined
      }
    },
    cloneWorkspace: async ({ remoteUrl, directoryName }) => {
      const parentPath = await workspaces.pickDirectory()
      if (parentPath === null) return undefined
      const workspace = await workspaces.cloneGit({ remoteUrl, parentPath, directoryName })
      return {
        workspaceId: workspace.workspaceId,
        title: workspace.title,
        normalizedRemoteUrl: normalizeGitRemoteUrl(remoteUrl),
      }
    },
  }
}

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const hostDescription = connection.hostDescription
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await ctx.sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const browserInjected = (): WorkspaceBrowserInjected => {
    const membership = ctx.get('projectMembershipClient')
    return {
      // Explicit group actions keep their target; unscoped New Session inherits
      // the current Session Workspace before the recent-Workspace fallback.
      startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
      open: (sessionId) => { ctx.sessions.open(sessionId) },
      searchSessions,
      searchResultLimit: ctx.sessions.searchResultLimit,
      renameSession: async (sessionId, title) => {
        // Row → session-face hop: rename is a per-session verb (ISession), not
        // a list-service verb; the binding resolves any listed session.
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
        const result = await session.rename(title)
        if (!result.ok) throw new Error(result.error.message)
      },
      forkSession: (sessionId) => {
        ctx.sessions.fork({ sessionId, increaseTitle: true })
          .then((childId) => { ctx.sessions.open(childId) })
          .catch(() => {
            // Fork or child-rename failure keeps the current selection.
          })
      },
      renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
      deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
      insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
        await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
      },
      archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId) },
      insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
        await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
      },
      createWorkspace: input => ctx.workspaces.create(input),
      ...(membership === undefined
        ? {}
        : { projectMembership: projectMembershipGateway(membership, ctx.workspaces, connection) }),
      hooks: { directoryFlow: browserFlowSource, hostDescription },
    }
  }
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
      store: createWorkspaceViewStore(),
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}
