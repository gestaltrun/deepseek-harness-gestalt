/**
 * ui-workspace contracts. Two registrations share this package:
 *
 * - WorkspaceBrowser fills the sidebar shell's `sidebar.workspaces` hole —
 *   the whole browsing region (section header, search, grouped/flat session
 *   list, workspace dialogs). It registers this package's viewing store and
 *   consumes the shell's two-fact owner share (wide / expandSidebar).
 * - WorkspacePicker fills the conversation empty-state hole (menu + error
 *   dialog shared with the browser).
 *
 * Each registration also declares one **directory-flow hole** (`single`
 * kind): the slot a composed picker package's client half fills with its
 * picking interaction — a renderless native-chooser driver or an in-app
 * browsing dialog. ui-workspace owns the trigger (the "Add workspace…"
 * entry, present only while the hole is occupied) and the adoption
 * semantics (`createWorkspace({ path })`, the retryable error dialog,
 * Choose again); the occupant owns everything between `open` and the picked path,
 * including creating a new directory to hand back. That occupant-owned
 * creation is why adding a workspace has a single route: an unoccupied hole
 * leaves the surface with no add affordance at all.
 * Two holes exist because the two menu surfaces are independent slot entries
 * and a hole has exactly one declaring entry — they carry the same owner
 * contract and the same occupant.
 */
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { createWorkspaceViewStore } from '../stores.ts'

/**
 * Owner share of the directory-flow holes: the complete conversation between
 * the trigger surface and the picking interaction. The occupant reads `open`
 * to run/render its interaction and reports exactly one outcome per open.
 */
export interface DirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). */
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /** Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). */
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** The two directory-flow holes; a flow package's client half registers its one component into both. */
export type DirectoryFlowSlotName =
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

/**
 * Directory-picking share both trigger surfaces consume. Occupancy rides the
 * inject face's reserved `hooks` compartment: the renderer binds the source
 * into the `useDirectoryFlow` selector hook, so an empty hole hides the
 * "Add workspace…" entry reactively and the surface withdraws an open
 * flow whose occupant unloaded mid-interaction (nobody is left to cancel).
 */
export type DirectoryPickingInjected = {
  hooks: {
    /** True while this surface's directory-flow hole is occupied. */
    directoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the picking share: the bound occupancy selector hook. */
export type DirectoryPickingHooks = PropsHooks<DirectoryPickingInjected['hooks']>

/**
 * Browser-private injected share (arrives via the register inject factory).
 * Data reads use the global framework hooks; these are the Host actions the
 * browsing region drives.
 */
export type WorkspaceBrowserInjected = {
  hooks: DirectoryPickingInjected['hooks'] & {
    /**
     * Fixed Host facts, reached through a hook rather than injected as values:
     * the renderer memoizes an entry's inject result for the registration's
     * lifetime, so facts read there would freeze at whatever the first render
     * saw. Select the field the surface needs (`info => info.home`).
     */
    hostInfo: HostObservable<RemoteHostFacts>
  }
  /**
   * Start a New Session in a Workspace: reuse-or-create its blank session and
   * open it; without an explicit workspace, inherit the current Session
   * Workspace, then the recent Workspace, or clear into the New Session view.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /**
   * Search current visible conversation messages. The Host fixes the result
   * bound; `hasMore` means the query needs narrowing.
   */
  searchSessions: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
  /** Maximum number of merged rows rendered for one search. */
  searchResultLimit: number
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork a Session at its last completed turn and open the child. */
  forkSession: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Reorder a Workspace in the durable registry display order.
   * Omitted anchor appends to the end.
   */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /**
   * Archive a Session into the registry-global set: hidden from grouping
   * surfaces, log and accounting slot retained. Archiving the current
   * session clears the selection into the New Session view state.
   */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /**
   * Reorder a session inside its Workspace account (DOM-insertBefore
   * semantics: omitted anchor appends to the end). The view refreshes from
   * the Host response/changed frame; failures leave the order unchanged.
   */
  insertSessionBefore: (workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId) => Promise<void>
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/** Cloud Project role used by workspace settings and the invite wizard. */
export type WorkspaceProjectRole = 'owner' | 'admin' | 'member'

/** Bound Cloud Project shown in workspace settings. */
export interface WorkspaceProjectView {
  /** Cloud Project id. */
  id: string
  /** Display name of the Cloud Project. */
  name: string
  /** Optional origin remote bound to the Cloud Project. */
  boundRemoteUrl?: string
  /** Account that opened the current settings surface. */
  receivingAccountId: string
}

/** One roster row in workspace settings. */
export interface WorkspaceMemberRow {
  /** Membership id used by role, tag, and removal actions. */
  membershipId: string
  /** Platform account id of the member. */
  accountId: string
  /** Display name shown in the roster. */
  displayName: string
  /** Avatar URL, or empty when the row uses initials. */
  avatarRef: string
  /** Current project role. */
  role: WorkspaceProjectRole
  /** Function tags shown in the roster editor. */
  tags: readonly string[]
  /** Presence reported for the member. */
  presence: 'online' | 'offline'
}

/** One pending outbound invitation shown under the roster. */
export interface WorkspaceIssuedInvitation {
  /** Invitation id used by retract. */
  invitationId: string
  /** Invitee display name. */
  inviteeName: string
  /** Role granted if the invitee accepts. */
  grantedRole: WorkspaceProjectRole
}

/** One inbound invitation offered by the invite wizard. */
export interface WorkspacePendingInvitation {
  /** Invitation id used by accept and decline. */
  invitationId: string
  /** Account that received the invitation. */
  receivingAccountId: string
  /** Cloud Project being offered. */
  projectId: string
  /** Cloud Project display name. */
  projectName: string
  /** Inviter display name. */
  inviterName: string
  /** Origin remote of the invited project. */
  remoteUrl: string
  /** Role granted if the invitee accepts. */
  grantedRole: WorkspaceProjectRole
}

/**
 * Composition-owned membership transport used by workspace settings and the
 * invite wizard. Desktop adapts the membership client onto this face.
 */
export interface ProjectMembershipGateway {
  /** Create a Cloud Project bound to one local Workspace. */
  createProject(input: { name: string; localWorkspaceId: WorkspaceId }): Promise<WorkspaceProjectView>
  /** Read the Cloud Project bound to one local Workspace, if any. */
  projectForWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceProjectView | undefined>
  /** Read the bound project's roster. */
  roster(projectId: string): Promise<{
    project: { id: string; name: string; boundRemoteUrl?: string }
    members: readonly WorkspaceMemberRow[]
  }>
  /** Invite a GitHub login into the bound project. */
  invite(input: {
    projectId: string
    githubLogin: string
    grantedRole: WorkspaceProjectRole
  }): Promise<{ invitationId: string; inviteeName: string; grantedRole: WorkspaceProjectRole }>
  /** Read outbound invitations that have not been decided. */
  issuedInvitations(projectId: string): Promise<readonly WorkspaceIssuedInvitation[]>
  /** Retract one outbound invitation. */
  retractInvitation(invitationId: string): Promise<void>
  /** Accept or decline one inbound invitation. */
  decideInvitation(
    invitationId: string,
    decision:
      | { decision: 'decline' }
      | {
        decision: 'accept-with-link'
        localWorkspaceId: WorkspaceId
        receivingAccountId: string
        projectId: string
        link: { workspaceName: string; normalizedRemoteUrl?: string }
      },
  ): Promise<void>
  /** Change one member's role. */
  changeRole(membershipId: string, role: WorkspaceProjectRole): Promise<void>
  /** Replace one member's function tags. */
  setMemberTags(membershipId: string, tags: readonly string[]): Promise<void>
  /** Remove one member from the bound project. */
  removeMember(membershipId: string): Promise<void>
  /** Read inbound invitations still pending for the current actor. */
  pendingInvitations(): Promise<readonly WorkspacePendingInvitation[]>
  /** Read the local origin remote for one Workspace, if Git reports one. */
  localRemoteFor(workspaceId: WorkspaceId): Promise<string | undefined>
  /** Clone the invited remote into a new local Workspace. */
  cloneWorkspace(input: {
    remoteUrl: string
    directoryName: string
  }): Promise<{ workspaceId: WorkspaceId; title: string; normalizedRemoteUrl: string } | undefined>
}

/** Full browser props: shell owner share + viewing store + injected actions + the locale seat. */
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<'sidebar.workspaces.directoryFlow'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & Omit<WorkspaceBrowserInjected, 'hooks'>
  & PropsHooks<WorkspaceBrowserInjected['hooks']>
  & PropsLocale<'workspace'>

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/**
 * Full picker props: the owner share plus the creation callback and the
 * locale seat. The two picker holes (blank-session hero / New-Session view)
 * share one owner currency, so one composed type serves both registrations.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'>
  & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>
  & Omit<WorkspacePickerInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>
