/** Desktop Mobile Pairing Settings section and bilingual pre-authorization notice. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ACCOUNT_PRIVACY_NOTICE } from '@deepseek-ai/dsh-platform-account/privacy'
import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAccountSnapshot } from '../protocol.ts'
import type { DesktopPairingSnapshot } from '../protocol.ts'
import { encode as encodeQrCode } from 'uqr'
import css from './AccountControl.module.css'

/** Injected current-installation Account snapshot. */
export type AccountControlInjected = {
  hooks: {
    account: {
      getSnapshot: () => DesktopAccountSnapshot
      subscribe: (listener: () => void) => () => void
    }
    pairing: {
      getSnapshot: () => DesktopPairingSnapshot
      subscribe: (listener: () => void) => () => void
    }
  }
}

/** Settings-section props plus Desktop copy and Account hook. */
export type AccountControlProps = PropsRuntime<'settings.section'>
  & PropsLocale<'desktop'>
  & {
    useAccount: SnapshotSelectorHook<DesktopAccountSnapshot>
    usePairing: SnapshotSelectorHook<DesktopPairingSnapshot>
  }

/** Render Account state inside the Desktop-only Mobile Pairing Settings section. */
export function AccountControl({ t, useAccount, usePairing }: AccountControlProps) {
  const snapshot = useAccount(value => value)
  const pairing = usePairing(value => value)
  const desktop = window.dshDesktop
  if (desktop === undefined) return null
  return (
    <section className={css.root} data-desktop-account-control={snapshot.status}>
      <header className={css.header}>
        <span className={css.mark}>G</span>
        <div>
          <h2>{t('account.title')}</h2>
          <p>{t('account.sectionDescription')}</p>
        </div>
      </header>
      <AccountPanel desktop={desktop} snapshot={snapshot} t={t} />
      {(snapshot.status === 'signed-in' || snapshot.status === 'signing-out')
        && <PairingPanel desktop={desktop} snapshot={pairing} t={t} />}
    </section>
  )
}

function PairingPanel({ desktop, snapshot, t }: {
  desktop: NonNullable<typeof window.dshDesktop>
  snapshot: DesktopPairingSnapshot
  t: AccountControlProps['t']
}) {
  const pending = snapshot.pending
  return (
    <div className={css.pairing} data-desktop-pairing={snapshot.status}>
      <div className={css.mobileAccess}>
        <div><strong>{t('pairing.mobileAccess')}</strong><p>{t('pairing.mobileAccessDescription')}</p></div>
        <button
          type="button"
          role="switch"
          aria-label={t('pairing.mobileAccess')}
          aria-checked={snapshot.enabled}
          className={css.toggle}
          disabled={snapshot.status === 'unavailable'}
          onClick={() => { void desktop.pairingSetEnabled(!snapshot.enabled) }}
        ><span /></button>
      </div>
      {snapshot.error !== undefined && <p className={css.error} role="alert">{snapshot.error}</p>}
      {snapshot.enabled && snapshot.status === 'ready' && (
        <Button variant="primary" onClick={() => { void desktop.pairingCreateChallenge() }}>
          {t('pairing.createChallenge')}
        </Button>
      )}
      {snapshot.challenge !== undefined && (
        <div className={css.challenge}>
          <PairingQr label={t('pairing.qrLabel')} value={snapshot.challenge.qrPayload} />
          <div><strong>{t('pairing.scan')}</strong><p>{t('pairing.fullLink')}</p><code>{snapshot.challenge.oneTimeLink}</code></div>
          <Button variant="outline" onClick={() => { void desktop.pairingCancelChallenge() }}>{t('pairing.cancel')}</Button>
        </div>
      )}
      {pending !== undefined && (
        <div className={css.pending}>
          <strong>{t('pairing.compareWords')}</strong>
          <p>{pending.deviceName}</p>
          <output>{pending.authenticationWords.join(' ')}</output>
          <div className={css.actions}>
            <Button variant="primary" onClick={() => { void desktop.pairingConfirm(pending.id) }}>{t('pairing.confirm')}</Button>
            <Button variant="outline" onClick={() => { void desktop.pairingReject(pending.id) }}>{t('pairing.reject')}</Button>
          </div>
        </div>
      )}
      {snapshot.pairings.map(pairing => (
        <div className={css.device} key={pairing.id}>
          <strong>{pairing.deviceName}</strong>
          <span>{pairing.platform}</span>
          <span>{pairing.online ? 'online' : 'offline'}</span>
          <span>Paired <time dateTime={new Date(pairing.pairedAt).toISOString()}>{new Date(pairing.pairedAt).toLocaleString()}</time></span>
          <span>
            Last access <time dateTime={new Date(pairing.lastAccessAt).toISOString()}>
              {new Date(pairing.lastAccessAt).toLocaleString()}
            </time>
          </span>
          <Button variant="outline" onClick={() => { void desktop.pairingRevoke(pairing.id) }}>{t('pairing.revoke')}</Button>
        </div>
      ))}
    </div>
  )
}

function PairingQr({ label, value }: { label: string; value: string }) {
  const qr = encodeQrCode(value, { ecc: 'M' })
  let path = ''
  for (let row = 0; row < qr.size; row += 1) {
    for (let column = 0; column < qr.size; column += 1) {
      if (qr.data[row]?.[column] === true) path += `M${String(column)} ${String(row)}h1v1h-1z`
    }
  }
  return (
    <figure className={css.qr}>
      <svg viewBox={`-2 -2 ${String(qr.size + 4)} ${String(qr.size + 4)}`} aria-label={label} role="img">
        <path d={path} />
      </svg>
      <code aria-label="Pairing QR payload">{value}</code>
    </figure>
  )
}

function AccountPanel({ desktop, snapshot, t }: {
  desktop: NonNullable<typeof window.dshDesktop>
  snapshot: DesktopAccountSnapshot
  t: AccountControlProps['t']
}) {
  if (snapshot.status === 'unavailable') {
    return <p className={css.error}>{snapshot.error ?? t('account.unavailable')}</p>
  }
  if ((snapshot.status === 'signed-in' || snapshot.status === 'signing-out') && snapshot.account !== undefined) {
    return (
      <div className={css.signedIn}>
        <img className={css.profileAvatar} src={snapshot.account.avatarUrl} alt="" />
        <div>
          <strong>{snapshot.account.githubLogin}</strong>
          <p>{t('account.currentInstallation')}</p>
        </div>
        <Button
          variant="outline"
          disabled={snapshot.status === 'signing-out'}
          onClick={() => { void desktop.accountSignOut() }}
        >
          {t('account.signOut')}
        </Button>
      </div>
    )
  }
  if (snapshot.status === 'polling' || snapshot.status === 'authorizing') {
    return (
      <div className={css.waiting} aria-live="polite">
        <span className={css.spinner} />
        <strong>{t('account.finishBrowser')}</strong>
        <p>{t('account.polling')}</p>
      </div>
    )
  }
  return (
    <div className={css.notice}>
      <div className={css.noticeHeader}>
        <span>{t('account.privacyBadge')}</span>
        <strong>{t('account.noticeTitle')}</strong>
      </div>
      <p lang="zh-CN">{ACCOUNT_PRIVACY_NOTICE.zh}</p>
      <p lang="en">{ACCOUNT_PRIVACY_NOTICE.en}</p>
      {snapshot.error !== undefined && <p className={css.error}>{snapshot.error}</p>}
      <label className={css.consent}>
        <input
          type="checkbox"
          checked={snapshot.privacyAccepted}
          onChange={() => { void desktop.accountAcceptPrivacy() }}
        />
        <span>{t('account.consent')}</span>
      </label>
      <Button
        variant="primary"
        disabled={!snapshot.privacyAccepted}
        onClick={() => { void desktop.accountBeginLogin() }}
      >
        {t('account.continueGitHub')}
      </Button>
    </div>
  )
}
