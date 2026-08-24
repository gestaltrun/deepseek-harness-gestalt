// ApprovalPanel: the composer-takeover approval prompt (designer draft
// approval.png), registered as a selector-routed entry of the
// conversation-declared composer chain. While an approval question is
// pending, this panel occupies the composer slot in place of the InputBar:
// an amber "Waiting for approval" strip on the card top, the model's
// justification as the headline, the paired command in muted code text, and
// a right-aligned refuse/allow action row. Justification and command are
// unbounded model text, so they scroll inside the card at the shared composer
// cap (`data-approval-scroll`) and the action row stays outside it — the
// buttons must be reachable no matter how long the command is.
// One-shot: the buttons disable
// after a click and the panel leaves (the InputBar returns) on the broadcast
// resolved frame.

import { useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSnapshot, PendingWait, RunningToolCall } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PendingApproval, type ApprovalComposerProps } from '../contract/slots.ts'
import { rootToolCall } from '../chat/tool-node-reader.ts'
import css from './ApprovalPanel.module.css'

/** Extract the shell command from an approval's paired running call (bash-family args carry `command`); undefined hides the line. */
export function commandOf(call: RunningToolCall | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    // Unparseable model args: the panel still renders, just without the command line.
    return undefined
  }
}

/**
 * Resolve the optional paired shell command from an authoritative Session projection.
 * @param snapshot - authoritative Session conversation projection.
 * @param approval - pending Approval whose command may still be running.
 * @returns paired shell command when the projection contains one.
 */
export function approvalCommandOf(
  snapshot: ConversationSnapshot,
  approval: PendingApproval,
): string | undefined {
  if (approval.callId === undefined) return undefined
  const root = rootToolCall(snapshot, approval.callId)
  if (root === undefined) return undefined
  return root.callId === approval.callId && !('kind' in root) ? commandOf(root) : undefined
}

/** Owner-defined Approval presentation props shared by Desktop and direct Web compositions. */
export interface ApprovalPresentationProps {
  wait: PendingWait<'approval'>
  command?: string | undefined
  t: TranslateNS<'conversation'>
  disabled?: boolean | undefined
}

/**
 * Render one Approval without constructing a Client Runtime standard kit.
 * @param props - pending Approval, optional command, translator, and mutation state.
 * @returns owner-defined Approval presentation.
 */
export function ApprovalPresentation({
  wait, command, t, disabled = false,
}: ApprovalPresentationProps) {
  const approval = useMemo(() => new PendingApproval(wait), [wait])
  return (
    <ApprovalFlow
      key={approval.key}
      pending={approval}
      t={t}
      disabled={disabled}
      {...command === undefined ? {} : { command }}
    />
  )
}

/**
 * Composer takeover boundary: mints the domain face on the carrier's stable
 * identity and remounts the flow per request key, so the one-shot answered
 * latch never leaks to the next pending approval.
 * @param props - the selector-matched pending approval carrier plus the framework standard kit.
 * @returns The approval prompt for this request.
 */
export function ApprovalPanel(props: ApprovalComposerProps & { disabled?: boolean | undefined }) {
  const approval = useMemo(() => new PendingApproval(props.matched), [props.matched])
  const command = props.useSession(snapshot => approvalCommandOf(snapshot, approval))
  return <ApprovalPresentation wait={props.matched} command={command} t={props.t} disabled={props.disabled} />
}

function ApprovalFlow({ pending, command, t, disabled }: {
  pending: PendingApproval
  command?: string
  t: ApprovalComposerProps['t']
  disabled: boolean
}) {
  // Local one-shot latch: the panel leaves only when the resolved frame
  // lands; until then the buttons must not re-fire. An answer failure
  // (rejected receipt / transport) re-arms them for retry.
  const [answered, setAnswered] = useState(false)
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setAnswered(true)
    void pending.answer(outcome).catch(() => { setAnswered(false) })
  }
  return (
    <div className={css.root} data-approval-key={pending.key}>
      <div className={css.card}>
        <div className={css.strip}><span className={css.dot} />{t('approval.waiting')}</div>
        {/* Tab stop: the region scrolls once the command passes the cap and
            holds nothing focusable of its own, so without one a keyboard-only
            user cannot reach the command's tail before answering. */}
        <div className={css.body} data-approval-scroll="" tabIndex={0} role="group" aria-label={t('approval.detail.aria')}>
          <div className={css.headline}>{pending.reason ?? t('approval.escalation', { toolName: pending.toolName })}</div>
          {command !== undefined && <div className={css.command}>{command}</div>}
        </div>
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered || disabled} onClick={() => { answer('rejected') }}>
            {t('approval.reject')}
          </Button>
          <Button variant="primary" disabled={answered || disabled} onClick={() => { answer('allowed-once') }}>
            {t('approval.allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}
