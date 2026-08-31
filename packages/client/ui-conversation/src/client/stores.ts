/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { CallId, ChatStoreState, DetailsDocumentFocus, SelectionTarget } from './contract/views.ts'

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  setView: (draft: ChatStoreState, view: string) => void
  setInspect: (draft: ChatStoreState, target: { callId: CallId } | null) => void
  setAnnotationDraft: (draft: ChatStoreState, value: ChatStoreState['annotationDraft']) => void
  focusDocument: (draft: ChatStoreState, document: DetailsDocumentFocus) => void
  clearDocumentFocus: (draft: ChatStoreState) => void
}

/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: consumers read the store through
    // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
    // and the contract cannot drift.
    init: (): ChatStoreState => ({ selection: null, draft: '', view: null, inspect: null, annotationDraft: null, documentFocus: null }),
    persist: 'dsh.conversation.chat',
    actions: {
      // A tool selection replaces any focused document: the two panel bodies
      // are mutually exclusive views of the same panel.
      select: (d, target: SelectionTarget | null) => { d.selection = target; d.documentFocus = null },
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, target: { callId: CallId } | null) => { d.inspect = target },
      setAnnotationDraft: (d, value: ChatStoreState['annotationDraft']) => { d.annotationDraft = value },
      focusDocument: (d, document: DetailsDocumentFocus) => { d.documentFocus = document },
      clearDocumentFocus: (d) => { d.documentFocus = null },
    },
  })
}
