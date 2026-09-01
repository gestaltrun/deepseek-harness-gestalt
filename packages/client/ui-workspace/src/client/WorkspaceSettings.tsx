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
import type { ProjectMembershipAccessSnapshot } from '@deepseek-ai/dsh-project-membership-client'
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

/**
 * The workspace settings modal. Unmounted when closed; the bound project and
 * its roster live in local state so a reopened modal re-reads fresh facts.
 */
export function WorkspaceSettingsModal({ workspaceId, workspaceTitle, gateway, access, openSignIn, onClose, t }: {
  /** Exact local Workspace whose Cloud Project relationship is being managed. */
  workspaceId: WorkspaceId
  /** Title of the workspace being configured (heading context only). */
  workspaceTitle: string
  gateway: ProjectMembershipGateway
  /** Framework-projected current-installation authorization state. */
  access?: ProjectMembershipAccessSnapshot
  /** Navigate to the product surface that owns Platform Account sign-in. */
  openSignIn?: () => void
  onClose: () => void
  t: SettingsTranslate
}) {
  const actualAccess = access ?? signedInAccessSnapshot
  const authorized = actualAccess.status === 'signed-in'
  const [projectResult, setProjectResult] = useState<{
    access: ProjectMembershipAccessSnapshot
    value: WorkspaceProjectView | null
  } | undefined>(undefined)
  const project = projectResult?.access === actualAccess ? projectResult.value : undefined
  const [name, setName] = useState('')
  const [remote, setRemote] = useState<string | null | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const trimmedName = name.trim()
  const createBlocked = creating || trimmedName === '' || remote === undefined || remote === null
  const visibleCreateError = createError ?? (project === null && remote === null ? t('upgrade.missingRemote') : null)
  useEffect(() => {
    if (!authorized) return
    let alive = true
    Promise.all([
      gateway.projectForWorkspace(workspaceId),
      gateway.localRemoteFor(workspaceId),
    ]).then(([existing, localRemote]) => {
      if (!alive) return
      setProjectResult({ access: actualAccess, value: existing ?? null })
      setRemote(localRemote ?? null)
    }).catch((reason: unknown) => {
      if (!alive) return
      setProjectResult({ access: actualAccess, value: null })
      setRemote(null)
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { alive = false }
  }, [actualAccess, authorized, gateway, workspaceId])
  const submitCreate = () => {
    /* v8 ignore next -- the create button uses the same createBlocked predicate. */
    if (createBlocked) return
    setCreating(true)
    setCreateError(null)
    gateway.createProject({ name: trimmedName, localWorkspaceId: workspaceId }).then((created) => {
      setCreating(false)
      setProjectResult({ access: actualAccess, value: created })
    }).catch((reason: unknown) => {
      setCreating(false)
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal open onClose={onClose} closeLabel={t('close')} title={t('settings.title')}>
      <div className={css.section}>
        <div className={css.sectionTitle}>{t('upgrade.title')}</div>
        {!authorized
          ? <ProjectMembershipAccessGate
            access={actualAccess}
            openSignIn={openSignIn}
            t={t}
          />
          : project === undefined
            ? <div className={css.sectionDesc}>{t('upgrade.loading')}</div>
            : project === null
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
                      value={remote ?? ''}
                      aria-label={t('upgrade.remoteUrl')}
                      readOnly
                    />
                  </label>
                  {visibleCreateError !== null && <div className={css.actionError} role="alert">{visibleCreateError}</div>}
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

const signedInAccessSnapshot = { status: 'signed-in' as const }

function ProjectMembershipAccessGate({ access, openSignIn, t }: {
  access: ProjectMembershipAccessSnapshot
  openSignIn: (() => void) | undefined
  t: SettingsTranslate
}) {
  const presentation = projectMembershipAccessGate(access.status, t)
  return (
    <div>
      <div className={css.subTitle}>{t('upgrade.accountRequired')}</div>
      <div className={css.sectionDesc}>{presentation.description}</div>
      {access.error !== undefined && <div className={css.actionError} role="alert">{access.error}</div>}
      {presentation.showSignIn && (
        <Button
          variant="primary"
          disabled={presentation.signInDisabled || openSignIn === undefined}
          onClick={openSignIn}
        >
          {t('upgrade.signIn')}
        </Button>
      )}
    </div>
  )
}

function projectMembershipAccessGate(
  status: ProjectMembershipAccessSnapshot['status'],
  t: SettingsTranslate,
): { description: string; showSignIn: boolean; signInDisabled: boolean } {
  switch (status) {
    case 'unavailable':
      return { description: t('upgrade.accountUnavailable'), showSignIn: false, signInDisabled: true }
    case 'signed-out':
      return { description: t('upgrade.accountDescription'), showSignIn: true, signInDisabled: false }
    case 'signing-in':
      return { description: t('upgrade.signingIn'), showSignIn: true, signInDisabled: true }
    case 'signing-out':
      return { description: t('upgrade.signingOut'), showSignIn: true, signInDisabled: true }
    case 'signed-in':
      throw new TypeError('signed-in Project Membership access cannot render the authorization gate')
    default:
      return assertNever(status)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unknown Project Membership access status: ${String(value)}`)
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
  const reloadIssued = () => {
    gateway.issuedInvitations(project.id).then((rows) => {
      if (alive.current) setIssued(rows)
    }).catch((reason: unknown) => {
      if (alive.current) setActionError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  useEffect(() => {
    reloadRoster()
    reloadIssued()
  }, [gateway, project.id])
  const trimmedLogin = login.trim()
  const inviteBlocked = inviting || trimmedLogin === ''
  const submitInvite = () => {
    /* v8 ignore next -- the invite button uses the same inviteBlocked predicate. */
    if (inviteBlocked) return
    setInviting(true)
    setActionError(null)
    gateway.invite({ projectId: project.id, githubLogin: trimmedLogin }).then(() => {
      setInviting(false)
      setLogin('')
      reloadIssued()
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
      reloadIssued()
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
          /* v8 ignore next -- a controlled select only emits its declared option values. */
          if (role !== 'owner' && role !== 'admin' && role !== 'member') return
          /* v8 ignore next -- selecting the current controlled option emits no change. */
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
  const [localRemotes, setLocalRemotes] = useState<ReadonlyMap<WorkspaceId, string | undefined>>(new Map())
  useEffect(() => {
    let disposed = false
    void Promise.all(workspaces.map(async workspace => [
      workspace.workspaceId,
      await gateway.localRemoteFor(workspace.workspaceId),
    ] as const)).then((rows) => {
      if (!disposed) setLocalRemotes(new Map(rows))
    }).catch(() => {
      // A transient Host/Git failure leaves candidates unbadged; acceptance remains available.
    })
    return () => { disposed = true }
  }, [gateway, workspaces])
  // A candidate with no known remote gets no badge; the invitation remote
  // itself recommends, a known different remote is labeled foreign.
  const badgeOf = (workspaceId: WorkspaceId): 'recommended' | 'foreign' | null => {
    const local = localRemotes.get(workspaceId)
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
  const confirmLink = async () => {
    // Linking is mandatory: no selection (and no clone intention) keeps the
    // confirm disabled, so this guard is the last line, not the affordance.
    /* v8 ignore next -- the confirm button uses the same busy and selection predicate. */
    if (busy || (selectedId === null && !cloneSelected)) return
    setBusy(true)
    setError(null)
    try {
      const selected = workspaces.find(candidate => candidate.workspaceId === selectedId)
      const cloned = cloneSelected
        ? await gateway.cloneWorkspace({
          remoteUrl: invitation.remoteUrl,
          directoryName: cloneDirectoryName(invitation.remoteUrl, invitation.projectName),
        })
        : undefined
      if (cloneSelected && cloned === undefined) {
        setBusy(false)
        return
      }
      const workspace = selected ?? cloned
      if (workspace === undefined) throw new Error('Workspace selection did not resolve')
      const localRemote = selected === undefined
        ? cloned?.normalizedRemoteUrl
        : localRemotes.get(selected.workspaceId)
      const link = {
        workspaceName: workspace.title,
        ...(localRemote === undefined ? {} : { normalizedRemoteUrl: localRemote }),
      }
      await gateway.decideInvitation(invitation.invitationId, {
        decision: 'accept-with-link',
        localWorkspaceId: workspace.workspaceId,
        receivingAccountId: invitation.receivingAccountId,
        projectId: invitation.projectId,
        link,
      })
      onClose()
    } catch (reason: unknown) {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
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
            onClick={() => { void confirmLink() }}
          >
            {busy ? t('wizard.link.joining') : t('wizard.link.confirm')}
          </Button>
        )}
    >
      {step === 'card'
        ? (
          <div className={css.wizardCard}>
            <div>{t('wizard.card.body', { inviter: invitation.inviterName, project: invitation.projectName })}</div>
            <div>{t('wizard.card.remote', { remote: invitation.remoteUrl })}</div>
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

/**
 * Derive one cross-platform-safe clone directory name from a Git remote.
 * @param remoteUrl - normalized invited-project remote.
 * @param fallback - project name used only when the remote has no path component.
 * @returns one non-reserved path segment.
 */
export function cloneDirectoryName(remoteUrl: string, fallback: string): string {
  const withoutSuffix = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const separator = Math.max(withoutSuffix.lastIndexOf('/'), withoutSuffix.lastIndexOf(':'))
  const repositoryName = withoutSuffix.slice(separator + 1) || fallback
  const safe = repositoryName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '')
    .trim()
  if (safe === '' || safe === '.' || safe === '..') return 'project'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? `project-${safe}` : safe
}
