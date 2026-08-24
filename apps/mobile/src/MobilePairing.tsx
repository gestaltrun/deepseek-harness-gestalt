import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './MobilePairing.module.css'
import type { MobilePairingActions } from './personal-pairing-model.ts'

export type { MobilePairingActions } from './personal-pairing-model.ts'

/**
 * Same-account Mobile pairing flow shown after Platform Account sign-in.
 * @param props - current pairing adapter.
 * @returns Settings-like Mobile flow for QR/link completion and word comparison.
 */
export function MobilePairing({
  actions,
  reportLifecycleError = defaultLifecycleErrorReporter,
}: {
  actions: MobilePairingActions
  reportLifecycleError?: (error: unknown) => void
}): ReactNode {
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
    return <section className={css.card}><h2>Personal Pairing</h2><p role="alert">{snapshot.error}</p></section>
  }
  if (snapshot.status === 'retryable') {
    return (
      <section className={css.card} data-mobile-pairing="retryable">
        <h2>配对尚未完成</h2>
        <p role="alert">{snapshot.error}</p>
        <button type="button" className={css.continue} onClick={() => { void actions.retryPairing() }}>重试配对</button>
        <small>重试会复用同一个一次性邀请和握手，不会创建新的设备权限。</small>
      </section>
    )
  }
  if (snapshot.status === 'pending') {
    return (
      <section className={css.card} data-mobile-pairing="pending">
        <h2>核对认证词</h2>
        <p>手机与 Desktop 必须显示完全相同的词。</p>
        <output>{snapshot.authenticationWords.join(' ')}</output>
        <strong>请在 Desktop 确认后继续</strong>
      </section>
    )
  }
  if (snapshot.status === 'unpair-failed') {
    return (
      <section className={css.card} data-mobile-pairing="unpair-failed">
        <h2>解除配对失败</h2>
        <p role="alert">部分本地或 Relay 权限可能仍然有效。请再次解除配对。</p>
        <small>{snapshot.error}</small>
        <button type="button" className={css.continue} onClick={unpair}>重试解除配对</button>
      </section>
    )
  }
  if (snapshot.status === 'paired') {
    return (
      <section className={css.card} data-mobile-pairing="paired">
        <h2>Paired Desktops</h2>
        <p>每次只选择一台 Desktop 作为 Relay、Session 和缓存权限来源。</p>
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
                  <small>{selected ? '当前选择' : '选择此 Desktop'}</small>
                </button>
              </li>
            )
          })}
        </ul>
        {snapshot.selectedPairingId === undefined && <p role="status">请选择一台 Paired Desktop 以连接。</p>}
        <button
          type="button"
          className={css.continue}
          disabled={snapshot.selectedPairingId === undefined}
          onClick={unpair}
        >解除所选 Desktop 配对</button>
        <h3>配对另一台 Desktop</h3>
        <p>扫描另一台 Desktop Settings 中的 QR，或粘贴同一个完整的一次性链接。</p>
        <button type="button" className={css.scan} onClick={startCamera}>扫描 QR</button>
        <div className={css.camera} hidden={!cameraActive}>
          <video ref={video} muted playsInline aria-label="Personal Pairing QR camera" />
          <p>将 Desktop Settings 中的 QR 对准取景框</p>
          <button type="button" className={css.scan} onClick={cancelCamera}>取消扫描</button>
        </div>
        <label>
          <span>完整的一次性配对链接</span>
          <input type="url" value={link} onChange={(event) => { setLink(event.target.value) }} />
        </label>
        <button
          type="button"
          className={css.continue}
          disabled={link === ''}
          onClick={() => { void Promise.resolve(actions.completeLink(link)).catch(() => undefined) }}
        >继续配对</button>
      </section>
    )
  }
  return (
    <section className={css.card} data-mobile-pairing={snapshot.status}>
      <h2>连接 Paired Desktop</h2>
      {snapshot.status !== 'ready' || snapshot.error === undefined ? null : <p role="alert">{snapshot.error}</p>}
      <p>扫描 Desktop Settings 中的 QR，或粘贴同一个完整的一次性链接。</p>
      <button type="button" className={css.scan} onClick={startCamera}>扫描 QR</button>
      <div className={css.camera} hidden={!cameraActive}>
        <video ref={video} muted playsInline aria-label="Personal Pairing QR camera" />
        <p>将 Desktop Settings 中的 QR 对准取景框</p>
        <button type="button" className={css.scan} onClick={cancelCamera}>取消扫描</button>
      </div>
      <label>
        <span>完整的一次性配对链接</span>
        <input type="url" value={link} onChange={(event) => { setLink(event.target.value) }} />
      </label>
      <button
        type="button"
        className={css.continue}
        disabled={link === '' || snapshot.status === 'completing'}
        onClick={() => { void Promise.resolve(actions.completeLink(link)).catch(() => undefined) }}
      >继续配对</button>
      <small>不提供短码；Desktop 明确确认前不会获得访问权限。</small>
    </section>
  )
}

function defaultLifecycleErrorReporter(error: unknown): void {
  console.error('[mobile-personal-pairing] lifecycle failure:', error)
}
