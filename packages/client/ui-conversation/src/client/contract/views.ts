/** Shared conversation view, selection, and store-state contracts. */
import type { PersistedAnnotationDraft } from '../annotation/model.ts'

/** Tool call identity as carried on the wire (branded upstream in connection). */
export type CallId = string

/**
 * One document focused in the details panel (the document-focus channel):
 * identity, who it came from, and — for renderable kinds — the inline body
 * the relay carried. `content` is absent for kinds the panel renders as a
 * bare file tab, where there is nothing to render but identity.
 */
export interface DetailsDocumentFocus {
  /** Workspace-relative document path (identity and later reopening). */
  path: string
  /** File name rendered as the panel title (the path's last segment). */
  filename: string
  /** Display name of the member the document came from. */
  from: string
  /** Inline document body for the renderable kinds; absent renders identity only. */
  content?: string
}

/**
 * Render dispatch of a focused document: `.md`/`.markdown` renders as
 * Markdown, `.html`/`.htm` renders as the sandboxed restricted preview, and
 * every other extension renders the bare file tab.
 * @param filename - focused file name.
 * @returns The dispatch kind.
 */
export function documentRenderKind(filename: string): 'markdown' | 'html' | 'file' {
  const name = filename.toLowerCase()
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown'
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  return 'file'
}

/** Selection target for the details linkage channel (toolcall is the step special case). */
export interface SelectionTarget { turnSeq: number; stepSeq?: number; callId?: CallId; toolName?: string }

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/**
 * Per-session state shared by conversation, chat-view, and details slots.
 * Unknown persisted view ids fall back to the stable Chat view.
 */
export interface ChatStoreState {
  /** Details-linkage channel (conversation writes, details reads). */
  selection: SelectionTarget | null
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: string
  /** Active conversation view id ('conversation.view' entry id); null falls back to Chat. */
  view: string | null
  /**
   * One-shot inspect handoff: chat writes the call to reveal, the trajectory
   * view consumes it and acknowledges by clearing. Read with `?? null` —
   * persisted snapshots from before this field rehydrate without it.
   */
  inspect: { callId: CallId } | null
  /**
   * Persisted Annotation Draft (identities, order, anchors, notes, and the id
   * sequence). Read with `?? null` — persisted snapshots from before this
   * field rehydrate without it; null = no draft.
   */
  annotationDraft: PersistedAnnotationDraft | null
  /**
   * Focused document rendered in place of the tool output (the document-focus
   * channel; cleared by the panel close and by the next tool selection). Read
   * with `?? null` — persisted snapshots from before this field rehydrate
   * without it.
   */
  documentFocus: DetailsDocumentFocus | null
}
