import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { QuestionPresentation } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import {
  memberBriefOf,
  selectMemberQuestion,
  type MemberQuestionComposerProps, type MemberQuestionDockProps,
  type MemberQuestionOrigin, type MemberQuestionRole,
} from './contract/slots.ts'
import type { MemberQuestionRecordView } from '@deepseek-ai/dsh-client-runtime/client'
import css from './MemberQuestionCard.module.css'

export type {
  MemberQuestionBrief, MemberQuestionComposerProps, MemberQuestionOrigin,
  MemberQuestionReferenceChip, MemberQuestionRole, MemberQuestionWait,
} from './contract/slots.ts'

/** Remaining-time display under one second of drift. */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * Ticking wall-clock countdown to the routed ask's expiry. One-second local
 * state against `Date.now()` — there is no external fact to subscribe to, the
 * deadline rides props, and the interval dies with the component.
 */
function Countdown({ expiresAt, expiredLabel }: { expiresAt: number; expiredLabel: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [])
  const remaining = expiresAt - now
  return (
    <span className={clsx(css.countdown, remaining <= 0 && css.countdownExpired)}>
      {remaining <= 0 ? expiredLabel : `⏳ ${formatRemaining(remaining)}`}
    </span>
  )
}

/** Avatar image, or the display name's first code point when no URL rides the origin. */
function Avatar({ origin }: { origin: MemberQuestionOrigin }) {
  return origin.askerAvatarUrl === undefined
    ? <span className={css.avatarFallback} aria-hidden="true">{Array.from(origin.askerDisplayName)[0] ?? ''}</span>
    : <img className={css.avatar} src={origin.askerAvatarUrl} alt="" />
}

/** Role badge copy for one collaboration-plane role. */
function roleLabel(t: MemberQuestionComposerProps['t'], role: MemberQuestionRole): string {
  return role === 'owner' ? t('role.owner') : role === 'admin' ? t('role.admin') : t('role.member')
}

/** Passive Host terminal records retained after a card settles. */
export function MemberQuestionRecords(props: {
  matched: readonly MemberQuestionRecordView[]
  t: MemberQuestionComposerProps['t']
}) {
  if (props.matched.length === 0) return null
  return (
    <div className={css.recordBands} data-member-question-records>
      {props.matched.map(record => (
        <div className={css.recordBand} data-record-state={record.state} key={record.questionId}>
          <span>{recordLabel(props.t, record)}</span>
          <time dateTime={new Date(record.terminalAt).toISOString()}>
            {new Date(record.terminalAt).toLocaleString()}
          </time>
        </div>
      ))}
    </div>
  )
}

function recordLabel(t: MemberQuestionComposerProps['t'], record: MemberQuestionRecordView): string {
  return record.state === 'answered-elsewhere'
    ? t('record.answered-elsewhere', { device: record.settledByDeviceName ?? t('origin.fallback') })
    : t(`record.${record.state}`)
}

/**
 * Member-question request presentation: the remote Decision Brief banner
 * (origin identity, project, source session, expiry countdown, clamped
 * background, material chips) over the shared question presentation on one
 * width axis. Pagination, multi-select, recommendation badges, and custom
 * answers stay the shared component's native behavior; this wrapper adds only
 * the banner and the collapse linkage.
 * @param props - selector-matched member-question carrier, standard kit, and the two translators.
 * @returns The composite card.
 */
export function MemberQuestionCard(props: MemberQuestionComposerProps) {
  const brief = useMemo(() => memberBriefOf(props.matched), [props.matched])
  // The shared presentation owns its own minimize toggle (aria-expanded);
  // observing it folds the whole card and marks the collapsed banner strip,
  // without owning or duplicating the presentation's draft state.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [innerCollapsed, setInnerCollapsed] = useState(false)
  const [innerRevealed, setInnerRevealed] = useState(false)
  const [detailsRevealed, setDetailsRevealed] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    const body = bodyRef.current
    /* v8 ignore next -- React assigns this mounted element ref before running the effect. */
    if (body === null) return
    const sync = (): void => {
      const toggle = body.querySelector('[aria-expanded]')
      setInnerCollapsed(toggle?.getAttribute('aria-expanded') === 'false')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(body, { attributes: true, attributeFilter: ['aria-expanded'], subtree: true })
    return () => { observer.disconnect() }
  }, [])

  // Details-panel linkage: the persistent details column carries its open
  // state as `aria-expanded` on `[data-details-panel]` (ui-layout's AppFrame);
  // the same observation mechanism folds the card to its strip while the
  // panel is open and restores it when the panel closes.
  useEffect(() => {
    const sync = (): void => {
      const panel = document.querySelector('[data-details-panel]')
      setDetailsOpen(panel?.getAttribute('aria-expanded') === 'true')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: ['aria-expanded'], subtree: true })
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    if (!innerCollapsed) setInnerRevealed(false)
  }, [innerCollapsed])

  useEffect(() => {
    if (!detailsOpen) setDetailsRevealed(false)
  }, [detailsOpen])

  const folded = (innerCollapsed && !innerRevealed) || (detailsOpen && !detailsRevealed)
  const askerName = brief.origin?.askerDisplayName ?? props.t('origin.fallback')
  const records = props.session?.memberQuestionRecords ?? []

  return (
    <div className={css.frame} data-question-key={props.matched.key} data-folded={folded || undefined}>
      <MemberQuestionRecords matched={records} t={props.t} />
      <section
        className={clsx(css.card, folded && css.cardFolded)}
        aria-label={props.t('collapsed.bar', { name: askerName })}
      >
        {folded && (
          <button
            type="button"
            className={css.foldedBar}
            aria-label={props.t('collapsed.bar', { name: askerName })}
            onClick={() => {
              if (innerCollapsed) setInnerRevealed(true)
              if (detailsOpen) setDetailsRevealed(true)
            }}
          >
            <span className={css.remoteTag}>{props.t('tag.remote')}</span>
            <span className={css.foldedSummary}>
              {props.t('collapsed.bar', { name: askerName })}
            </span>
            <span className={css.foldedMark}>{props.t('collapsed.mark')}</span>
          </button>
        )}
        {!folded && (
          <header className={css.banner}>
            <div className={css.originRow}>
              <span className={css.remoteTag}>{props.t('tag.remote')}</span>
              {brief.origin !== undefined && (
                <span className={css.asker}>
                  <Avatar origin={brief.origin} />
                  <span className={css.askerName}>{brief.origin.askerDisplayName}</span>
                  <span className={css.roleBadge}>{roleLabel(props.t, brief.origin.askerRole)}</span>
                </span>
              )}
              {brief.expiresAt !== undefined && (
                <Countdown expiresAt={brief.expiresAt} expiredLabel={props.t('countdown.expired')} />
              )}
            </div>
            {brief.origin !== undefined && (
              <div className={css.contextRow}>
                <span className={css.contextItem}>
                  <span className={css.contextLabel}>{props.t('project.label')}</span>
                  {brief.origin.projectName}
                </span>
                <span className={css.contextItem}>
                  <span className={css.contextLabel}>{props.t('session.label')}</span>
                  {brief.origin.originSessionTitle}
                </span>
              </div>
            )}
            {brief.background !== undefined && (
              <div className={css.background}>
                <span className={css.contextLabel}>{props.t('background.label')}</span>
                <p className={css.backgroundText}>{brief.background}</p>
              </div>
            )}
            {brief.references.length > 0 && (
              <div className={css.references}>
                <span className={css.contextLabel}>{props.t('references.label')}</span>
                <div className={css.chips}>
                  {brief.references.map(chip => (
                    <button
                      type="button"
                      className={css.chip}
                      key={`${chip.filename}-${chip.reason}`}
                      onClick={() => {
                        if (chip.cachedPath === undefined) return
                        props.openReference(props.sessionId, chip.cachedPath, chip.filename)
                      }}
                    >
                      <span className={css.chipFilename}>{chip.filename}</span>
                      <span className={css.chipReason}>{chip.reason}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </header>
        )}
        {/* Kept mounted while folded: the presentation owns the drafts, and
            folding must not spend them. */}
        <div className={clsx(css.body, folded && css.bodyHidden)} ref={bodyRef} data-member-presentation>
          <QuestionPresentation wait={props.matched} t={props.questionT} />
        </div>
      </section>
    </div>
  )
}

/** Additive Decision Brief dock above the unchanged product composer. */
export function MemberQuestionDock(props: MemberQuestionDockProps) {
  const matched = selectMemberQuestion({ interactions: props.session.pending })
  if (matched === null) {
    return <MemberQuestionRecords matched={props.session.memberQuestionRecords ?? []} t={props.t} />
  }
  return <MemberQuestionCard {...props} interactions={props.session.pending} matched={matched} />
}
