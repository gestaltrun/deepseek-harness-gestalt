/** Desktop-only Sub2API offer card in Settings: render-only, Host pushes state. */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopSub2ApiSnapshot } from '../protocol.ts'
import css from './Sub2ApiControl.module.css'

/** Injected Sub2API component snapshot. */
export type Sub2ApiControlInjected = {
  hooks: {
    sub2api: {
      getSnapshot: () => DesktopSub2ApiSnapshot
      subscribe: (listener: () => void) => () => void
    }
  }
}

/** Settings-section props plus Desktop copy and the Sub2API hook. */
export type Sub2ApiControlProps = PropsRuntime<'settings.section'>
  & PropsLocale<'desktop'>
  & {
    useSub2api: SnapshotSelectorHook<DesktopSub2ApiSnapshot>
  }

/** Render the offer card from the Host-pushed snapshot; no local state machine. */
export function Sub2ApiControl({ t, useSub2api }: Sub2ApiControlProps) {
  const snapshot = useSub2api(value => value)
  const consoleUrl = useSub2ApiConsoleUrl()
  const frame = useAutoSizedConsoleFrame()
  const desktop = window.dshDesktop
  if (desktop === undefined) return null
  const running = snapshot.state === 'running'
  return (
    <section className={css.root} data-desktop-sub2api-state={snapshot.state}>
      <header className={css.header}>
        <div className={css.headerCopy}>
          <h2>{t('sub2api.title')}</h2>
          <p>{t('sub2api.offerBody')}</p>
        </div>
        {running && <OfferPanel desktop={desktop} snapshot={snapshot} t={t} />}
      </header>
      <div className={css.body} data-desktop-sub2api-enabled={snapshot.enabled}>
        {!running && <OfferPanel desktop={desktop} snapshot={snapshot} t={t} />}
        {running && (
          <iframe
            ref={frame.ref}
            className={css.consoleFrame}
            src={consoleUrl}
            style={{ height: `${String(frame.height)}px` }}
            title={t('sub2api.consoleTitle')}
            onLoad={frame.connect}
          />
        )}
      </div>
    </section>
  )
}

const DEFAULT_CONSOLE_HEIGHT = 720

/** Grow the same-origin native workspace so the surrounding Settings page owns vertical scrolling. */
function useAutoSizedConsoleFrame(): {
  ref: RefObject<HTMLIFrameElement>
  height: number
  connect: () => void
} {
  const ref = useRef<HTMLIFrameElement>(null)
  const observer = useRef<ResizeObserver | undefined>(undefined)
  const [height, setHeight] = useState(DEFAULT_CONSOLE_HEIGHT)
  const measure = useCallback(() => {
    const content = ref.current?.contentDocument
    if (content === undefined || content === null) return
    const next = Math.max(
      DEFAULT_CONSOLE_HEIGHT,
      content.documentElement.scrollHeight,
      content.body.scrollHeight,
    )
    setHeight(next)
  }, [])
  const connect = useCallback(() => {
    observer.current?.disconnect()
    const content = ref.current?.contentDocument
    if (content === undefined || content === null) return
    const nextObserver = new ResizeObserver(measure)
    nextObserver.observe(content.documentElement)
    nextObserver.observe(content.body)
    observer.current = nextObserver
    measure()
  }, [measure])
  useEffect(() => () => { observer.current?.disconnect() }, [])
  return { ref, height, connect }
}

function sub2ApiConsoleUrl(): string {
  const presented = document.documentElement.style.colorScheme
  const media = typeof matchMedia === 'undefined'
    ? undefined
    : matchMedia('(prefers-color-scheme: dark)')
  const theme = presented === 'dark' || presented === 'light'
    ? presented
    : media?.matches === true ? 'dark' : 'light'
  const lang = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return `/plugins/dsh-sub2api/ui/admin/accounts?embed=desktop&theme=${theme}&lang=${lang}`
}

/** Reload the embedded native workspace when Desktop theme or locale changes. */
function useSub2ApiConsoleUrl(): string {
  const [url, setUrl] = useState(sub2ApiConsoleUrl)
  useEffect(() => {
    const sync = (): void => {
      const next = sub2ApiConsoleUrl()
      setUrl(current => current === next ? current : next)
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'lang'] })
    const media = typeof matchMedia === 'undefined'
      ? undefined
      : matchMedia('(prefers-color-scheme: dark)')
    media?.addEventListener('change', sync)
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', sync)
    }
  }, [])
  return url
}

/** The per-phase body: one status line plus the actions that phase allows. */
function OfferPanel({ desktop, snapshot, t }: {
  desktop: NonNullable<typeof window.dshDesktop>
  snapshot: DesktopSub2ApiSnapshot
  t: Sub2ApiControlProps['t']
}) {
  const [confirmingUninstall, setConfirmingUninstall] = useState(false)
  const uninstallRow = confirmingUninstall && (
    <div className={css.uninstallConfirm}>
      <Button variant="outline" onClick={() => { void desktop.sub2ApiUninstall(false) }}>
        {t('sub2api.uninstallKeep')}
      </Button>
      <Button variant="outline" onClick={() => { void desktop.sub2ApiUninstall(true) }}>
        {t('sub2api.uninstallDelete')}
      </Button>
      <Button variant="ghost" onClick={() => { setConfirmingUninstall(false) }}>
        {t('sub2api.cancel')}
      </Button>
    </div>
  )
  switch (snapshot.state) {
    case 'missing':
      return (
        <div className={css.stack}>
          <strong>{t('sub2api.offerTitle')}</strong>
          <p>{t('sub2api.downloadNote')}</p>
          <p>{t('sub2api.dataNote')}</p>
          <Button variant="primary" onClick={() => { void desktop.sub2ApiEnable() }}>
            {t('sub2api.download')}
          </Button>
        </div>
      )
    case 'downloading':
      return (
        <div className={css.stack} aria-live="polite">
          <span className={css.spinner} />
          <strong aria-live="polite">
            {snapshot.downloadPercent === undefined
              ? t('sub2api.downloadingIndeterminate')
              : t('sub2api.downloading').replace('{percent}', String(snapshot.downloadPercent))}
          </strong>
        </div>
      )
    case 'verifying':
      return (
        <div className={css.stack} aria-live="polite">
          <span className={css.spinner} />
          <strong>{t('sub2api.verifying')}</strong>
        </div>
      )
    case 'installed':
      return (
        <div className={css.stack}>
          <strong>
            {t('sub2api.installed')}{snapshot.version === undefined ? '' : ` · ${snapshot.version}`}
          </strong>
          {!snapshot.enabled && (
            <>
              <p>{t('sub2api.disabled')}</p>
              <div className={css.actions}>
                <Button variant="primary" onClick={() => { void desktop.sub2ApiEnable() }}>{t('sub2api.enable')}</Button>
                <Button variant="outline" onClick={() => { setConfirmingUninstall(true) }}>{t('sub2api.uninstall')}</Button>
              </div>
            </>
          )}
          {uninstallRow}
        </div>
      )
    case 'starting':
      return (
        <div className={css.stack} aria-live="polite">
          <span className={css.spinner} />
          <strong>{t('sub2api.starting')}</strong>
        </div>
      )
    case 'running':
      return (
        <div className={css.runningControls}>
          <strong>
            {t('sub2api.running')}{snapshot.version === undefined ? '' : ` · ${snapshot.version}`}
          </strong>
          <div className={css.actions}>
            <Button variant="outline" onClick={() => { void desktop.sub2ApiDisable() }}>
              {t('sub2api.disable')}
            </Button>
            <Button variant="ghost" onClick={() => { setConfirmingUninstall(true) }}>
              {t('sub2api.uninstall')}
            </Button>
          </div>
          {uninstallRow}
        </div>
      )
    case 'error':
      return (
        <div className={css.stack}>
          <p className={css.error} role="alert">{snapshot.error}</p>
          <div className={css.actions}>
            <Button variant="primary" onClick={() => { void desktop.sub2ApiEnable() }}>{t('sub2api.retry')}</Button>
            <Button variant="outline" onClick={() => { setConfirmingUninstall(true) }}>{t('sub2api.uninstall')}</Button>
          </div>
          {uninstallRow}
        </div>
      )
  }
}
