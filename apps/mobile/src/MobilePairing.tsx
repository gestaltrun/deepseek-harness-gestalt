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
  reportLifecycleError = defaultLifecycleErrorReporter,
}: {
  actions: MobilePairingActions
  locale: 'zh' | 'en'
  reportLifecycleError?: (error: unknown) => void
}): ReactNode {
  const text = PAIRING_TEXT[locale]
  const snapshot = useSyncExternalStore(
    listener => actions.subscribe(listener),
    () => actions.getSnapshot(),
  )
  const [link, setLink] = useState('')
  const [cameraActive, setCameraActive] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const cameraAbort = useRef<AbortController>()
  useEffect(() => {
    void actions.activate().catch(reportLifecycleError)
    return () => {
      cameraAbort.current?.abort()
      void actions.deactivate().catch(reportLifecycleError)
    }
  }, [actions, reportLifecycleError])

  const startCamera = (): void => {
    const preview = video.current
    if (preview === null) return
    cameraAbort.current?.abort()
    const controller = new AbortController()
    cameraAbort.current = controller
    setCameraActive(true)
    void Promise.resolve(actions.scanQr(preview, controller.signal))
      .catch(() => undefined)
      .finally(() => {
        if (cameraAbort.current !== controller) return
        cameraAbort.current = undefined
        setCameraActive(false)
      })
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
    return <section className={css.card}><h2>{text.personalPairing}</h2><p role="alert">{snapshot.error}</p></section>
  }
  if (snapshot.status === 'retryable') {
    return (
      <section className={css.card} data-mobile-pairing="retryable">
        <h2>{text.retryHeading}</h2>
        <p role="alert">{snapshot.error}</p>
        <button type="button" className={css.continue} onClick={() => { void actions.retryPairing() }}>{text.retry}</button>
        <small>{text.retryDetail}</small>
      </section>
    )
  }
  if (snapshot.status === 'pending') {
    return (
      <section className={css.card} data-mobile-pairing="pending">
        <h2>{text.verifyWords}</h2>
        <p>{text.wordsDetail}</p>
        <output>{snapshot.authenticationWords.join(' ')}</output>
        <strong>{text.confirmOnDesktop}</strong>
      </section>
    )
  }
  if (snapshot.status === 'unpair-failed') {
    return (
      <section className={css.card} data-mobile-pairing="unpair-failed">
        <h2>{text.unpairFailed}</h2>
        <p role="alert">{text.unpairFailedDetail}</p>
        <small>{snapshot.error}</small>
        <button type="button" className={css.continue} onClick={unpair}>{text.retryUnpair}</button>
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
    <section className={css.card} data-mobile-pairing={snapshot.status}>
      <h2>{text.connectDesktop}</h2>
      {snapshot.status !== 'ready' || snapshot.error === undefined ? null : <p role="alert">{snapshot.error}</p>}
      <p>{text.connectDetail}</p>
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
        disabled={link === '' || snapshot.status === 'completing'}
        onClick={() => { void Promise.resolve(actions.completeLink(link)).catch(() => undefined) }}
      >{text.continuePairing}</button>
      <small>{text.noShortCode}</small>
    </section>
  )
}

function defaultLifecycleErrorReporter(error: unknown): void {
  console.error('[mobile-personal-pairing] lifecycle failure:', error)
}

const PAIRING_TEXT = {
  zh: {
    personalPairing: '个人配对',
    retryHeading: '配对尚未完成',
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
