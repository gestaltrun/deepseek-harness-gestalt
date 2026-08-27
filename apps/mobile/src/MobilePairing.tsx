import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './MobilePairing.module.css'
import type { MobilePairingActions } from './personal-pairing-model.ts'

export type { MobilePairingActions } from './personal-pairing-model.ts'

/**
 * Same-account Mobile pairing flow shown after Platform Account sign-in.
 * @param props - current pairing adapter and product locale.
 * @returns Settings-like Mobile flow for QR/link completion and word comparison.
 */
export function MobilePairing({
  actions,
  locale,
  manageLifecycle = true,
  reportLifecycleError = defaultLifecycleErrorReporter,
}: {
  actions: MobilePairingActions
  locale: 'zh' | 'en'
  /** Whether this visible page owns the signed-in pairing controller lifecycle. */
  manageLifecycle?: boolean
  reportLifecycleError?: (error: unknown) => void
}): ReactNode {
  const text = PAIRING_TEXT[locale]
  const snapshot = useSyncExternalStore(
    listener => actions.subscribe(listener),
    () => actions.getSnapshot(),
  )
  const [link, setLink] = useState('')
  const [pairingMethod, setPairingMethod] = useState<'scan' | 'link'>('scan')
  const [cameraActive, setCameraActive] = useState(false)
  const [dismissedRejection, setDismissedRejection] = useState<ReturnType<MobilePairingActions['getSnapshot']>>()
  const video = useRef<HTMLVideoElement>(null)
  const cameraAbort = useRef<AbortController>()
  useEffect(() => {
    if (manageLifecycle) void actions.activate().catch(reportLifecycleError)
    return () => {
      cameraAbort.current?.abort()
      if (manageLifecycle) void actions.deactivate().catch(reportLifecycleError)
    }
  }, [actions, manageLifecycle, reportLifecycleError])

  useEffect(() => {
    if (!cameraActive) return
    const preview = video.current
    if (preview === null) return
    cameraAbort.current?.abort()
    const controller = new AbortController()
    cameraAbort.current = controller
    void Promise.resolve(actions.scanQr(preview, controller.signal))
      .catch(() => undefined)
      .finally(() => {
        if (cameraAbort.current !== controller) return
        cameraAbort.current = undefined
        setCameraActive(false)
      })
    return () => {
      if (cameraAbort.current !== controller) return
      controller.abort()
      cameraAbort.current = undefined
    }
  }, [actions, cameraActive])

  const startCamera = (): void => {
    setCameraActive(true)
  }

  const cancelCamera = (): void => {
    cameraAbort.current?.abort()
    cameraAbort.current = undefined
    setCameraActive(false)
  }

  const unpair = (): void => {
    void actions.unpair().catch(reportLifecycleError)
  }

  if (snapshot.status === 'unavailable') {
    return (
      <section className={`${css.card} ${css.taskCard}`}>
        <PairingHero kind="unavailable" />
        <div className={css.taskCopy}><h2>{text.personalPairing}</h2><p role="alert">{snapshot.error}</p></div>
      </section>
    )
  }
  if (snapshot.status === 'rejected' && snapshot !== dismissedRejection) {
    return (
      <section className={`${css.card} ${css.taskCard}`} data-mobile-pairing="rejected">
        <PairingHero kind="unavailable" />
        <div className={css.taskCopy}><h2>{text.rejectedHeading}</h2><p role="alert">{snapshot.error}</p></div>
        <div className={css.taskActions}>
          <button type="button" className={css.continue} onClick={() => { setDismissedRejection(snapshot) }}>{text.restartPairing}</button>
          <small>{text.restartPairingDetail}</small>
        </div>
      </section>
    )
  }
  if (snapshot.status === 'retryable') {
    return (
      <section className={`${css.card} ${css.taskCard}`} data-mobile-pairing="retryable">
        <PairingHero kind="retry" />
        <div className={css.taskCopy}><h2>{text.retryHeading}</h2><p role="alert">{snapshot.error}</p></div>
        <div className={css.taskActions}>
          <button type="button" className={css.continue} onClick={() => { void actions.retryPairing() }}>{text.retry}</button>
          <small>{text.retryDetail}</small>
        </div>
      </section>
    )
  }
  if (snapshot.status === 'pending') {
    return (
      <section className={`${css.card} ${css.taskCard}`} data-mobile-pairing="pending">
        <PairingHero kind="verify" />
        <div className={css.taskCopy}><h2>{text.verifyWords}</h2><p>{text.wordsDetail}</p></div>
        <output>{snapshot.authenticationWords.join(' ')}</output>
        <strong className={css.pendingStatus}>{text.confirmOnDesktop}</strong>
      </section>
    )
  }
  if (snapshot.status === 'unpair-failed') {
    return (
      <section className={`${css.card} ${css.taskCard}`} data-mobile-pairing="unpair-failed">
        <PairingHero kind="unavailable" />
        <div className={css.taskCopy}>
          <h2>{text.unpairFailed}</h2>
          <p role="alert">{text.unpairFailedDetail}</p>
          <small>{snapshot.error}</small>
        </div>
        <div className={css.taskActions}><button type="button" className={css.continue} onClick={unpair}>{text.retryUnpair}</button></div>
      </section>
    )
  }
  if (snapshot.status === 'paired') {
    return (
      <section className={css.card} data-mobile-pairing="paired">
        <h2>{text.pairedDesktops}</h2>
        <p>{text.selectionDetail}</p>
        {snapshot.error === undefined ? null : <p role="alert">{snapshot.error}</p>}
        <ul className={css.desktops}>
          {snapshot.desktops.map((desktop) => {
            const selected = desktop.pairingId === snapshot.selectedPairingId
            const label = desktop.desktopName ?? desktop.pairingId
            return (
              <li key={desktop.pairingId}>
                <button
                  type="button"
                  className={css.desktop}
                  aria-pressed={selected}
                  onClick={() => { void Promise.resolve(actions.selectDesktop(desktop.pairingId)).catch(reportLifecycleError) }}
                >
                  <strong>{label}</strong>
                  <small>{selected ? text.selected : text.selectDesktop}</small>
                </button>
              </li>
            )
          })}
        </ul>
        {snapshot.selectedPairingId === undefined && <p role="status">{text.selectPrompt}</p>}
        <button
          type="button"
          className={css.continue}
          disabled={snapshot.selectedPairingId === undefined}
          onClick={unpair}
        >{text.unpairSelected}</button>
        <h3>{text.pairAnother}</h3>
        <p>{text.pairAnotherDetail}</p>
        <button type="button" className={css.scan} onClick={startCamera}>{text.scanQr}</button>
        <div className={css.camera} hidden={!cameraActive}>
          <video ref={video} muted playsInline aria-label={text.cameraLabel} />
          <p>{text.cameraDetail}</p>
          <button type="button" className={css.scan} onClick={cancelCamera}>{text.cancelScan}</button>
        </div>
        <label>
          <span>{text.completeLink}</span>
          <input type="url" value={link} onChange={(event) => { setLink(event.target.value) }} />
        </label>
        <button
          type="button"
          className={css.continue}
          disabled={link === ''}
          onClick={() => { void Promise.resolve(actions.completeLink(link)).catch(() => undefined) }}
        >{text.continuePairing}</button>
      </section>
    )
  }
  return (
    <section
      className={`${css.card} ${css.taskCard}`}
      data-mobile-pairing={snapshot.status === 'rejected' ? 'ready' : snapshot.status}
    >
      <div className={css.methodStage} data-pairing-method={pairingMethod}>
        {pairingMethod === 'link'
          ? (
            <div className={css.linkFallback}>
              <label>
                <span>{text.completeLink}</span>
                <input
                  autoFocus
                  type="url"
                  value={link}
                  onChange={(event) => { setLink(event.target.value) }}
                />
              </label>
              <button
                type="button"
                className={css.continue}
                disabled={link === '' || snapshot.status === 'completing'}
                onClick={() => { void Promise.resolve(actions.completeLink(link)).catch(() => undefined) }}
              >{text.continuePairing}</button>
            </div>
          )
          : cameraActive
            ? (
              <div className={css.camera}>
                <video ref={video} muted playsInline aria-label={text.cameraLabel} />
                <p>{text.cameraDetail}</p>
                <button type="button" className={css.scan} onClick={cancelCamera}>{text.cancelScan}</button>
              </div>
            )
            : <PairingHero kind="connect" />}
      </div>
      <div className={css.taskCopy}>
        <h2>{text.connectDesktop}</h2>
        {snapshot.status !== 'ready' || snapshot.error === undefined ? null : <p role="alert">{snapshot.error}</p>}
        <p>{text.connectDetail}</p>
      </div>
      <div className={css.taskActions}>
        {pairingMethod === 'scan' && !cameraActive && (
          <button type="button" className={`${css.scan} ${css.primaryAction}`} onClick={startCamera}>{text.scanQr}</button>
        )}
        <button
          type="button"
          className={css.linkToggle}
          onClick={() => {
            if (pairingMethod === 'scan') {
              cancelCamera()
              setPairingMethod('link')
            } else {
              setPairingMethod('scan')
            }
          }}
        >{pairingMethod === 'scan' ? text.pasteLink : text.scanInstead}</button>
        <small>{text.noShortCode}</small>
      </div>
    </section>
  )
}

function PairingHero({ kind }: { kind: 'connect' | 'verify' | 'retry' | 'unavailable' }): ReactNode {
  return <span className={css.heroIcon} data-pairing-hero={kind}>{PAIRING_ICONS[kind]}</span>
}

function defaultLifecycleErrorReporter(error: unknown): void {
  console.error('[mobile-personal-pairing] lifecycle failure:', error)
}

const PAIRING_TEXT = {
  zh: {
    personalPairing: '个人配对',
    retryHeading: '配对尚未完成',
    rejectedHeading: '配对未获授权',
    restartPairing: '配对另一台桌面端',
    restartPairingDetail: '请在 Desktop 创建新的完整一次性邀请后重新扫码或粘贴。',
    retry: '重试配对',
    retryDetail: '重试会复用同一个一次性邀请和握手，不会创建新的设备权限。',
    verifyWords: '核对认证词',
    wordsDetail: '手机与桌面端必须显示完全相同的词。',
    confirmOnDesktop: '请在桌面端确认后继续',
    unpairFailed: '解除配对失败',
    unpairFailedDetail: '部分本地或 Relay 权限可能仍然有效。请再次解除配对。',
    retryUnpair: '重试解除配对',
    pairedDesktops: '已配对的桌面端',
    selectionDetail: '每次只选择一台桌面端作为中继、会话和缓存权限来源。',
    selected: '当前选择',
    selectDesktop: '选择此桌面端',
    selectPrompt: '请选择一台已配对的桌面端以连接。',
    unpairSelected: '解除所选桌面端配对',
    pairAnother: '配对另一台桌面端',
    pairAnotherDetail: '扫描另一台桌面端设置中的二维码，或粘贴同一个完整的一次性链接。',
    scanQr: '扫描二维码',
    pasteLink: '改为粘贴完整链接',
    scanInstead: '改为扫描二维码',
    cameraLabel: '个人配对二维码相机',
    cameraDetail: '将桌面端设置中的二维码对准取景框',
    cancelScan: '取消扫描',
    completeLink: '完整的一次性配对链接',
    continuePairing: '继续配对',
    connectDesktop: '连接已配对的桌面端',
    connectDetail: '扫描桌面端设置中的二维码，或粘贴同一个完整的一次性链接。',
    noShortCode: '不提供短码；桌面端明确确认前不会获得访问权限。',
  },
  en: {
    personalPairing: 'Personal Pairing',
    retryHeading: 'Pairing is not complete',
    rejectedHeading: 'Pairing was not authorized',
    restartPairing: 'Pair another Desktop',
    restartPairingDetail: 'Create a new complete one-time invitation on Desktop, then scan or paste it.',
    retry: 'Retry pairing',
    retryDetail: 'Retrying reuses the same one-time invitation and handshake without creating new device authority.',
    verifyWords: 'Verify authentication words',
    wordsDetail: 'Mobile and Desktop must display exactly the same words.',
    confirmOnDesktop: 'Confirm on Desktop to continue',
    unpairFailed: 'Unpairing failed',
    unpairFailedDetail: 'Some local or Relay authority may still be active. Try unpairing again.',
    retryUnpair: 'Retry unpairing',
    pairedDesktops: 'Paired Desktops',
    selectionDetail: 'Select one Desktop at a time as the Relay, Session, and cache authority.',
    selected: 'Selected',
    selectDesktop: 'Select this Desktop',
    selectPrompt: 'Select a Paired Desktop to connect.',
    unpairSelected: 'Unpair selected Desktop',
    pairAnother: 'Pair another Desktop',
    pairAnotherDetail: 'Scan the QR in another Desktop\'s Settings or paste the same complete one-time link.',
    scanQr: 'Scan QR',
    pasteLink: 'Paste the complete link instead',
    scanInstead: 'Scan a QR instead',
    cameraLabel: 'Personal Pairing QR camera',
    cameraDetail: 'Point the camera at the QR in Desktop Settings',
    cancelScan: 'Cancel scan',
    completeLink: 'Complete one-time pairing link',
    continuePairing: 'Continue pairing',
    connectDesktop: 'Connect a Paired Desktop',
    connectDetail: 'Scan the QR in Desktop Settings or paste the same complete one-time link.',
    noShortCode: 'Short codes are unavailable; access starts only after explicit Desktop confirmation.',
  },
} as const

const PAIRING_ICONS = {
  connect: (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
      <path d="M14 14h3v3h-3zm4 4h3v3h-3zm-4 3h2m5-7v2" />
    </svg>
  ),
  verify: (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.6 2.8 7.8 7 10 4.2-2.2 7-5.4 7-10V6l-7-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" />
    </svg>
  ),
  retry: (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7L20 14" /><path d="M20 7v4h-4" />
    </svg>
  ),
  unavailable: (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" />
    </svg>
  ),
} as const
