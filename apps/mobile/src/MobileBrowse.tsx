import { useMemo, useState, type ReactNode } from 'react'
import type { CompanionInteraction } from './companion-approval.ts'
import {
  COMPANION_HISTORY_PAGE_SIZE,
  groupCompanionSessions,
  pageCompanionHistory,
  type CompanionSessionSummary,
} from './companion-history.ts'
import type { CompanionPushState } from './companion-push.ts'
import { MobileConversation } from './MobileConversation.tsx'
import css from './MobileBrowse.module.css'

/** Mobile Companion browse props. */
export interface MobileBrowseProps {
  /** Selected Desktop display name. */
  desktopName: string
  /** Live Remote Online / Offline label. */
  connection: 'online' | 'offline'
  /** Desktop-confirmed Session history. */
  sessions: readonly CompanionSessionSummary[]
  /** Optional create handler used by Workspace and global create actions. */
  onCreate?: (input: { workspace?: string }) => void
  /** Submit a prompt through Desktop acceptance. */
  onSubmit?: (sessionId: string, text: string) => void
  /** Cancel the active prompt through Desktop cancellation. */
  onCancel?: (sessionId: string) => void
  /** Offer a local file on the open Session. */
  onAttach?: (sessionId: string, file: File) => void
  /** Forward a Desktop-authorized interaction settlement. */
  onSettled?: (sessionId: string, interaction: CompanionInteraction) => void
  /** Process visibility required before conversation settlement. */
  companionState?: CompanionPushState
}

/** Phone-sized Workspace/Session browse without Desktop columns. */
export function MobileBrowse({
  desktopName, connection, sessions, onCreate, onSubmit, onCancel, onAttach, onSettled, companionState,
}: MobileBrowseProps): ReactNode {
  const [openId, setOpenId] = useState<string>()
  const [workspaceName, setWorkspaceName] = useState('')
  const [page, setPage] = useState(0)
  const canCreate = onCreate !== undefined && connection === 'online'
  const paged = useMemo(
    () => pageCompanionHistory(sessions, page, COMPANION_HISTORY_PAGE_SIZE),
    [sessions, page],
  )
  const grouped = useMemo(() => groupCompanionSessions(paged.visible), [paged.visible])
  const open = sessions.find(session => session.id === openId)

  if (open !== undefined) {
    if (open.blocks !== undefined) {
      return (
        <MobileConversation
          title={open.title}
          onBack={() => { setOpenId(undefined) }}
          blocks={open.blocks}
          streaming={open.live === true}
          {...(onSubmit === undefined ? {} : { onSubmit: (text) => { onSubmit(open.id, text) } })}
          {...(onCancel === undefined ? {} : { onCancel: () => { onCancel(open.id) } })}
          {...(onAttach === undefined ? {} : { onAttach: (file) => { onAttach(open.id, file) } })}
          {...(onSettled === undefined ? {} : { onSettled: (interaction) => { onSettled(open.id, interaction) } })}
          {...(companionState === undefined ? {} : { companionState })}
        />
      )
    }
    return (
      <section className={css.page} data-mobile-browse="conversation">
        <header className={css.header}>
          <button type="button" className={css.back} onClick={() => { setOpenId(undefined) }}>返回</button>
          <h1>{open.title}</h1>
        </header>
        {open.live === true && open.transcript !== undefined
          ? <ol className={css.transcript}>{open.transcript.map((line, index) => <li key={index}>{line}</li>)}</ol>
          : <p className={css.summary}>{open.summary}</p>}
      </section>
    )
  }

  return (
    <section className={css.page} data-mobile-browse="list">
      <header className={css.header}>
        <p className={css.desktop}>{desktopName}</p>
        <p className={css.connection} data-connection={connection}>{connection === 'online' ? 'Remote Online' : 'Remote Offline'}</p>
        {onCreate !== undefined && (
          <>
            <button type="button" disabled={!canCreate} onClick={() => { onCreate({}) }}>新建 Ungrouped Session</button>
            <input
              aria-label="Workspace 名称"
              value={workspaceName}
              disabled={!canCreate}
              onChange={(event) => { setWorkspaceName(event.target.value) }}
            />
            <button
              type="button"
              disabled={!canCreate || workspaceName.trim() === ''}
              onClick={() => {
                const workspace = workspaceName.trim()
                if (workspace === '') return
                onCreate({ workspace })
                setWorkspaceName('')
              }}
            >
              在新 Workspace 新建 Session
            </button>
          </>
        )}
      </header>
      {grouped.groups.map(group => (
        <section key={group.name} className={css.group} aria-label={group.name}>
          <h2>{group.name}</h2>
          {onCreate !== undefined && (
            <button
              type="button"
              disabled={!canCreate}
              onClick={() => { onCreate({ workspace: group.name }) }}
            >
              在 {group.name} 新建 Session
            </button>
          )}
          <SessionList sessions={group.sessions} onOpen={setOpenId} />
        </section>
      ))}
      {grouped.ungrouped.length > 0 && (
        <section className={css.group} aria-label="Ungrouped">
          <h2>Ungrouped</h2>
          <SessionList sessions={grouped.ungrouped} onOpen={setOpenId} />
        </section>
      )}
      {paged.spilled > 0 && (
        <button type="button" className={css.more} onClick={() => { setPage(current => current + 1) }}>
          加载更多（还有 {paged.spilled}）
        </button>
      )}
    </section>
  )
}

function SessionList({
  sessions,
  onOpen,
}: {
  sessions: readonly CompanionSessionSummary[]
  onOpen: (id: string) => void
}): ReactNode {
  return (
    <ul className={css.sessions}>
      {sessions.map(session => (
        <li key={session.id}>
          <button type="button" onClick={() => { onOpen(session.id) }}>
            <strong>{session.title}</strong>
            <span>{session.summary}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
