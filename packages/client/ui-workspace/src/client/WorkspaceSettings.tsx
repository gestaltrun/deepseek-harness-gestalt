/**
 * Workspace settings modal (workspace row ⋯ → 工作区设置) and the invite
 * wizard. The settings body carries the workspace-upgrade block — cloud
 * project creation with name/remote validation plus member management
 * (display name, role, function tags, presence dot, removal, GitHub-login
 * invitations, retractable pending rows). Every action routes through the
 * {@link ProjectMembershipGateway} the composition adapts from the
 * membership client transport. The invite wizard is a two-step modal fed by
 * the pending-invitation poll: the invitation card (accept/decline), then
 * the mandatory local-workspace link step — same remote recommends, a known
 * different remote is labeled 异源, and a new clone is always selectable.
 * Closing the wizard decides nothing: the invitation stays pending.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type {
  ProjectMembershipGateway, WorkspaceIssuedInvitation, WorkspaceMemberRow,
  WorkspacePendingInvitation, WorkspaceProjectView,
} from './contract/slots.ts'
import css from './WorkspaceSettings.module.css'

/** The standard locale seat, prop-passed from the browser root. */
type SettingsTranslate = WorkspaceBrowserProps['t']

/** Local workspace offered as a wizard link candidate. */
export interface WizardWorkspace {
  workspaceId: WorkspaceId
  title: string
}

/** Git remotes are accepted only as http(s) repository URLs. */
const REMOTE_PATTERN = /^https?:\/\/\S+\/\S+$/u

/**
 * The workspace settings modal. Unmounted when closed; the bound project and
 * its roster live in local state so a reopened modal re-reads fresh facts.
 */
export function WorkspaceSettingsModal({ workspaceTitle, gateway, onClose, t }: {
  /** Title of the workspace being configured (heading context only). */
  workspaceTitle: string
  gateway: ProjectMembershipGateway
  onClose: () => void
  t: SettingsTranslate
}) {
  const [project, setProject] = useState<WorkspaceProjectView | null>(null)
  const [name, setName] = useState('')
  const [remote, setRemote] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const trimmedName = name.trim()
  const trimmedRemote = remote.trim()
  // Creation stays blocked while either field is empty or the remote is not
  // an http(s) repository URL; the error line names which rule failed.
  const createBlocked = creating || trimmedName === '' || trimmedRemote === ''
  const invalidRemote = trimmedRemote !== '' && !REMOTE_PATTERN.test(trimmedRemote)
  const submitCreate = () => {
    if (createBlocked) return
    if (invalidRemote) {
      setCreateError(t('upgrade.invalidRemote'))
      return
    }
    setCreating(true)
    setCreateError(null)
    gateway.createProject({ name: trimmedName, remoteUrl: trimmedRemote }).then((created) => {
      setCreating(false)
      setProject(created)
    }).catch((reason: unknown) => {
      setCreating(false)
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal open onClose={onClose} closeLabel={t('close')} title={t('settings.title')}>
      <div className={css.section}>
        <div className={css.sectionTitle}>{t('upgrade.title')}</div>
        {project === null
          ? (
            <div>
              <div className={css.sectionDesc}>{t('upgrade.desc')}</div>
              <label className={css.fieldLabel}>
                {t('upgrade.projectName')}
                <input
                  className={css.fieldInput}
                  value={name}
                  aria-label={t('upgrade.projectName')}
                  disabled={creating}
                  onChange={(e) => { setName(e.target.value); setCreateError(null) }}
                />
              </label>
              <label className={css.fieldLabel}>
                {t('upgrade.remoteUrl')}
                <input
                  className={css.fieldInput}
                  value={remote}
                  aria-label={t('upgrade.remoteUrl')}
                  placeholder="https://github.com/org/repo"
                  disabled={creating}
                  onChange={(e) => { setRemote(e.target.value); setCreateError(null) }}
                />
              </label>
              {createError !== null && <div className={css.actionError} role="alert">{createError}</div>}
              <Button variant="primary" disabled={createBlocked} onClick={submitCreate}>
                {creating ? t('upgrade.creating') : t('upgrade.create')}
              </Button>
            </div>
          )
          : (
            <div>
              <div className={css.sectionDesc}>{t('upgrade.bound', { name: project.name })}</div>
              <MemberManagement gateway={gateway} project={project} t={t} />
            </div>
          )}
      </div>
      <div className={css.settingsWorkspace} aria-hidden="true">{workspaceTitle}</div>
    </Modal>
  )
}

/** Roster + invitation administration for one bound cloud project. */
function MemberManagement({ gateway, project, t }: {
  gateway: ProjectMembershipGateway
  project: WorkspaceProjectView
  t: SettingsTranslate
}) {
  const [members, setMembers] = useState<readonly WorkspaceMemberRow[] | null>(null)
  const [issued, setIssued] = useState<readonly WorkspaceIssuedInvitation[]>([])
  const [retractingId, setRetractingId] = useState<string | null>(null)
  const [login, setLogin] = useState('')
  const [inviting, setInviting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const reloadRoster = () => {
    gateway.roster(project.id).then((view) => {
      if (alive.current) setMembers(view.members)
    }).catch((reason: unknown) => {
      if (alive.current) setActionError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  useEffect(reloadRoster, [gateway, project.id])
  const trimmedLogin = login.trim()
  const inviteBlocked = inviting || trimmedLogin === ''
  const submitInvite = () => {
    if (inviteBlocked) return
    setInviting(true)
    setActionError(null)
    gateway.invite({ projectId: project.id, githubLogin: trimmedLogin }).then((row) => {
      setInviting(false)
      setLogin('')
      setIssued(rows => [...rows, row])
    }).catch((reason: unknown) => {
      setInviting(false)
      setActionError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const retract = (invitationId: string) => {
    setRetractingId(invitationId)
    setActionError(null)
    gateway.retractInvitation(invitationId).then(() => {
      if (!alive.current) return
      setRetractingId(null)
      setIssued(rows => rows.filter(row => row.invitationId !== invitationId))
    }).catch((reason: unknown) => {
      if (!alive.current) return
      setRetractingId(null)
      setActionError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const act = (run: () => Promise<void>) => {
    setActionError(null)
    run().then(reloadRoster).catch((reason: unknown) => {
      setActionError(reason instanceof Error ? reason.message : String(reason))
      reloadRoster()
    })
  }
  return (
    <div className={css.members}>
      <div className={css.sectionTitle}>{t('members.title')}</div>
      {members === null
        ? <div className={css.sectionDesc} role="status">{t('members.loading')}</div>
        : members.length === 0
          ? <div className={css.sectionDesc}>{t('members.empty')}</div>
          : (
            <ul className={css.memberList}>
              {members.map(row => (
                <MemberRowItem
                  key={row.membershipId}
                  row={row}
                  gateway={gateway}
                  onAct={act}
                  t={t}
                />
              ))}
            </ul>
          )}
      {issued.length > 0 && (
        <div>
          <div className={css.subTitle}>{t('invitations.pending')}</div>
          <ul className={css.memberList}>
            {issued.map(row => (
              <li key={row.invitationId} className={css.memberRow}>
                <span className={css.memberName}>{row.inviteeName}</span>
                <Button
                  variant="outline"
                  disabled={retractingId !== null}
                  onClick={() => { retract(row.invitationId) }}
                >
                  {retractingId === row.invitationId ? t('invitations.retracting') : t('invitations.retract')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={css.inviteRow}>
        <input
          className={css.fieldInput}
          value={login}
          aria-label={t('members.inviteLogin')}
          placeholder={t('members.inviteLogin')}
          disabled={inviting}
          onChange={(e) => { setLogin(e.target.value); setActionError(null) }}
        />
        <Button variant="primary" disabled={inviteBlocked} onClick={submitInvite}>
          {inviting ? t('members.inviting') : t('members.invite')}
        </Button>
      </div>
      {actionError !== null && <div className={css.actionError} role="alert">{actionError}</div>}
    </div>
  )
}

/** One roster row: presence dot, display name, role picker, tag editor, removal. */
function MemberRowItem({ row, gateway, onAct, t }: {
  row: WorkspaceMemberRow
  gateway: ProjectMembershipGateway
  onAct: (run: () => Promise<void>) => void
  t: SettingsTranslate
}) {
  const [tagsDraft, setTagsDraft] = useState(row.tags.join(', '))
  const commitTags = () => {
    const tags = tagsDraft.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
    const unchanged = tags.length === row.tags.length && tags.every((tag, i) => tag === row.tags[i])
    if (unchanged) return
    onAct(() => gateway.setMemberTags(row.membershipId, tags))
  }
  return (
    <li className={css.memberRow}>
      <span className={css.presence} title={row.presence === 'online' ? t('members.online') : t('members.offline')}>
        {row.presence === 'online' ? <StateDot state="done" /> : <span className={css.offlineDot} aria-hidden="true" />}
        <span className="visually-hidden">{row.presence === 'online' ? t('members.online') : t('members.offline')}</span>
      </span>
      <span className={css.memberName}>{row.displayName === '' ? row.accountId : row.displayName}</span>
      <select
        className={css.roleSelect}
        aria-label={t('members.title')}
        value={row.role}
        onChange={(e) => {
          const role = e.target.value
          if (role !== 'owner' && role !== 'admin' && role !== 'member') return
          if (role === row.role) return
          onAct(() => gateway.changeRole(row.membershipId, role))
        }}
      >
        <option value="owner">owner</option>
        <option value="admin">admin</option>
        <option value="member">member</option>
      </select>
      <input
        className={css.tagsInput}
        value={tagsDraft}
        aria-label={t('members.tagsPlaceholder')}
        placeholder={t('members.tagsPlaceholder')}
        onChange={(e) => { setTagsDraft(e.target.value) }}
        onBlur={commitTags}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitTags()
          }
        }}
      />
      <Button variant="outline" onClick={() => { onAct(() => gateway.removeMember(row.membershipId)) }}>
        {t('members.remove')}
      </Button>
    </li>
  )
}

/**
 * Two-step invite wizard. `onClose` (mask or close button) decides nothing —
 * the invitation stays pending and the poll offers it again.
 */
export function InviteWizardModal({ invitation, workspaces, gateway, onClose, t }: {
  invitation: WorkspacePendingInvitation
  /** Local workspaces offered as link candidates. */
  workspaces: readonly WizardWorkspace[]
  gateway: ProjectMembershipGateway
  onClose: () => void
  t: SettingsTranslate
}) {
  const [step, setStep] = useState<'card' | 'link'>('card')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cloneSelected, setCloneSelected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remoteFor = gateway.localRemoteFor
  // A candidate with no known remote gets no badge; the invitation remote
  // itself recommends, a known different remote is labeled foreign.
  const badgeOf = (workspaceId: WorkspaceId): 'recommended' | 'foreign' | null => {
    if (invitation.remoteUrl === undefined || remoteFor === undefined) return null
    const local = remoteFor(workspaceId)
    if (local === undefined) return null
    return local === invitation.remoteUrl ? 'recommended' : 'foreign'
  }
  const close = () => {
    if (busy) return
    onClose()
  }
  const decline = () => {
    setBusy(true)
    setError(null)
    gateway.decideInvitation(invitation.invitationId, { decision: 'decline' }).then(onClose).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const confirmLink = () => {
    // Linking is mandatory: no selection (and no clone intention) keeps the
    // confirm disabled, so this guard is the last line, not the affordance.
    if (busy || (selectedId === null && !cloneSelected)) return
    setBusy(true)
    setError(null)
    const selected = workspaces.find(candidate => candidate.workspaceId === selectedId)
    const localRemote = selected !== undefined && remoteFor !== undefined
      ? remoteFor(selected.workspaceId)
      : undefined
    const link = {
      workspaceName: selected === undefined ? invitation.projectName : selected.title,
      ...(localRemote === undefined ? {} : { normalizedRemoteUrl: localRemote }),
    }
    gateway.decideInvitation(invitation.invitationId, {
      decision: 'accept-with-link',
      link,
    }).then(onClose).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={step === 'card' ? t('wizard.card.title') : t('wizard.link.title')}
      footer={step === 'card'
        ? (
          <>
            <Button variant="outline" disabled={busy} onClick={decline}>
              {busy ? t('wizard.declining') : t('wizard.decline')}
            </Button>
            <Button variant="primary" onClick={() => { setStep('link') }}>{t('wizard.accept')}</Button>
          </>
        )
        : (
          <Button
            variant="primary"
            disabled={busy || (selectedId === null && !cloneSelected)}
            onClick={confirmLink}
          >
            {busy ? t('wizard.link.joining') : t('wizard.link.confirm')}
          </Button>
        )}
    >
      {step === 'card'
        ? (
          <div className={css.wizardCard}>
            {t('wizard.card.body', { inviter: invitation.inviterName, project: invitation.projectName })}
          </div>
        )
        : (
          <div>
            <ul className={css.linkList}>
              {workspaces.map((candidate) => {
                const badge = badgeOf(candidate.workspaceId)
                return (
                  <li key={candidate.workspaceId} className={css.linkRow}>
                    <label className={css.linkLabel}>
                      <input
                        type="radio"
                        name="wizard-link-candidate"
                        checked={selectedId === candidate.workspaceId}
                        onChange={() => {
                          setSelectedId(candidate.workspaceId)
                          setCloneSelected(false)
                        }}
                      />
                      <span className={css.memberName}>{candidate.title}</span>
                      {badge === 'recommended' && <span className={css.badgeRecommended}>{t('wizard.link.recommended')}</span>}
                      {badge === 'foreign' && <span className={css.badgeForeign}>{t('wizard.link.foreign')}</span>}
                    </label>
                  </li>
                )
              })}
              <li className={css.linkRow}>
                <label className={css.linkLabel}>
                  <input
                    type="radio"
                    name="wizard-link-candidate"
                    checked={cloneSelected}
                    onChange={() => {
                      setCloneSelected(true)
                      setSelectedId(null)
                    }}
                  />
                  <span className={css.memberName}>{t('wizard.link.clone')}</span>
                </label>
              </li>
            </ul>
            {selectedId === null && !cloneSelected && (
              <div className={css.actionError} role="alert">{t('wizard.link.required')}</div>
            )}
          </div>
        )}
      {error !== null && <div className={css.actionError} role="alert">{error}</div>}
    </Modal>
  )
}
