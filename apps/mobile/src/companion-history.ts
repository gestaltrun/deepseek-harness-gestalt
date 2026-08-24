/** Mobile composition over Desktop-owned Session list and conversation projections. */

import type {
  ConversationSnapshot, SessionId, SessionListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  MobileCompanionAttachmentSnapshot,
  MobileCompanionOperationFailure,
  MobileCompanionSearchSnapshot,
} from './companion-surface.ts'

/** Default history page ceiling for phone-sized paging. */
export const COMPANION_HISTORY_PAGE_SIZE = 20

/** Desktop-authoritative conversations keyed by the same Session ids as the list projection. */
export type CompanionConversationMap = Readonly<Partial<Record<SessionId, ConversationSnapshot>>>

/** Production composition accepted by the bundled Mobile entry. */
export interface MobileCompanionPresentation {
  /** Selected Paired Desktop name. */
  desktopName: string
  /** Desktop reachability at the latest foreground synchronization. */
  connection: 'online' | 'offline'
  /** Exact Desktop Session list projection. */
  sessions: SessionListState
  /** Exact Desktop Workspace list used by the shared grouping owner. */
  workspaces: readonly WorkspaceView[]
  /** Opened Desktop conversation projections keyed by Session id. */
  conversations: CompanionConversationMap
  /** Read one authorized historical image from the selected Session. */
  loadImage: (sessionId: SessionId, attachment: ImageAttachmentRef) => Promise<string>
  /** Whether current foreground synchronization admits mutation controls. */
  canMutate: boolean
  /** Current Desktop-authoritative full-text search state. */
  search: MobileCompanionSearchSnapshot
  /** Latest selected-file transfer and its correlated Desktop outcome. */
  attachment: MobileCompanionAttachmentSnapshot
  /** Latest non-attachment mutation or refresh failure. */
  operationFailure?: MobileCompanionOperationFailure | undefined
  /** Latest Companion Cache deletion failure; cached content was retained. */
  cacheFailure?: string | undefined
  /** Create one Desktop-default Session when mutation authority is available. */
  onCreate?: ((input: { workspace?: string }) => void) | undefined
  /** Acknowledge that Mobile committed the selected Session detail view. */
  onSessionOpened?: ((sessionId: SessionId) => void) | undefined
  /** Submit a prompt through Desktop authority when transport is available. */
  onSubmit?: ((sessionId: SessionId, text: string) => void | Promise<void>) | undefined
  /** Cancel a running Desktop Session when transport is available. */
  onCancel?: ((sessionId: SessionId) => void) | undefined
  /** Load the preceding authoritative history window. */
  onLoadOlder?: ((sessionId: SessionId) => void) | undefined
  /** Select an attachment for encrypted transfer through Desktop. */
  onAttach?: ((sessionId: SessionId, file: File) => void) | undefined
  /** Request one full-text Session search from Desktop. */
  onSearch?: ((query: string) => void) | undefined
  /** Clear cached content for this Paired Desktop without deleting pairing keys. */
  onClearCache?: (() => void | Promise<void>) | undefined
}

/** Page exact Desktop Session ids and their Workspace memberships without projecting another row model. */
export function pageCompanionHistory(
  sessions: SessionListState,
  workspaces: readonly WorkspaceView[],
  page: number,
  ceiling: number = COMPANION_HISTORY_PAGE_SIZE,
): { sessions: SessionListState; workspaces: readonly WorkspaceView[]; spilled: number } {
  if (!Number.isSafeInteger(page) || page < 0) throw new TypeError('Companion history page must be a non-negative integer')
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) throw new TypeError('Companion history ceiling must be a positive integer')
  const end = (page + 1) * ceiling
  const ids = sessions.ids.slice(0, end)
  const visibleIds = new Set(ids)
  return {
    sessions: { ...sessions, ids },
    workspaces: workspaces.map((workspace) => {
      const sessionIds = workspace.sessionIds.filter(id => visibleIds.has(id))
      return sessionIds.length === workspace.sessionIds.length ? workspace : { ...workspace, sessionIds }
    }),
    spilled: Math.max(0, sessions.ids.length - end),
  }
}
