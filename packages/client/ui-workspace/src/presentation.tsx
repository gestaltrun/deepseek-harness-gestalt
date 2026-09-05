/** Public Session list/row presentation shared by Desktop and narrow Web compositions. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionNodeItem } from './client/rows/Rows.tsx'
import { deriveGroups, type GroupNode } from './client/tree.ts'
import { en, zh } from './client/locales.ts'

/** Locale ids supported by the shared Workspace/Session presentation. */
export type WorkspacePresentationLocale = 'zh' | 'en'

/**
 * Bind the Workspace dictionaries without constructing a Client Runtime.
 * @param locale - selected product locale.
 * @returns translator accepted by the shared Workspace components.
 */
export function workspacePresentationTranslate(locale: WorkspacePresentationLocale): TranslateNS<'workspace'> {
  const dictionary: Record<string, string> = locale === 'zh' ? zh : en
  const translate: TranslateNS<'workspace'> = (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match)
  }
  return translate
}

/**
 * Derive fully expanded Desktop Workspace groups for a narrow list shell.
 * @param sessions - Desktop-authoritative Session list projection.
 * @param workspaces - Desktop-authoritative Workspace projection.
 * @returns the same grouped Session nodes derived by Desktop WorkspaceBrowser.
 */
export function expandedSessionGroups(
  sessions: SessionListState,
  workspaces: readonly WorkspaceView[],
): readonly GroupNode[] {
  const collapsed = deriveGroups(sessions, workspaces, [], new Map(), { expandedGroups: [] })
  return deriveGroups(sessions, workspaces, [], new Map(), { expandedGroups: collapsed.map(group => group.key) })
}

/** Props for the shared Desktop Session row list. */
export interface SessionListPresentationProps {
  /** Accessible name for this Session tree. */
  label: string
  nodes: readonly GroupNode['sessions'][number][]
  currentId?: SessionId | undefined
  now: number
  onOpen: (id: SessionId) => void
  t: TranslateNS<'workspace'>
}

/**
 * Render Session rows through the same owner implementation used by Desktop WorkspaceBrowser.
 * @param props - grouped Session nodes, selection, clock, open action, and translator.
 * @returns shared Desktop Session rows without Desktop-only mutation menus.
 */
export function SessionListPresentation({
  label, nodes, currentId, now, onOpen, t,
}: SessionListPresentationProps): ReactNode {
  const preferred = nodes.some(node => node.id === currentId) ? currentId : nodes[0]?.id
  const [focusId, setFocusId] = useState(preferred)
  const tree = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!nodes.some(node => node.id === focusId)) setFocusId(preferred)
  }, [focusId, nodes, preferred])
  return (
    <div role="tree" aria-label={label} ref={tree}>
      {nodes.map(node => (
        <SessionNodeItem
          key={node.id}
          node={node}
          currentId={currentId}
          now={now}
          onOpen={onOpen}
          onRename={() => {}}
          onFork={() => {}}
          onArchive={() => {}}
          flat
          t={t}
        />
      ))}
    </div>
  )
}
