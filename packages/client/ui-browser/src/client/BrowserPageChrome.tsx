/**
 * Official page chrome for one Session-owned page.
 * The workbench sidebar tab bar is the page list; this pane has no tab strip.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserPageState, BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import type { BrowserPageChromeActions } from './slots.ts'
import {
  browserTabTitle, openPageOf, pageScreenshotSrc, persistentProfileLabel, resolveBrowserAddress,
} from './model.ts'
import { useBrowserPage } from './use-browser-page.ts'
import { desktopPageSurfaceOf, useDesktopPageSurface } from './desktop-page-surface.ts'
import { isBrowserRevisionConflict } from './listed-mutation.ts'
import css from './BrowserPageChrome.module.css'

/** Translate face used by the chrome copy keys. */
export type BrowserPageChromeTranslate = (key: string) => string

/** Props for one official page pane. */
export interface BrowserPageChromeProps extends BrowserPageChromeActions {
  /** Complete tab identity, or undefined while create is in flight. */
  target: BrowserTarget | undefined
  /** Binder-committed revision for this tab, when known. */
  listedRevision?: number
  /** Localized chrome strings. */
  t: BrowserPageChromeTranslate
  /** False when the snapshot tab is hidden. */
  visible?: boolean
  /** Called when observe settles on an open page. */
  onCommittedPage?: (page: BrowserPageState) => void
}

/**
 * Address bar and live-or-screenshot viewport for one page.
 * @param props - Session-bound remotes and the page identity.
 * @returns the chrome tree, or a creating placeholder when the target is absent.
 */
export function BrowserPageChrome({
  target, listedRevision, refresh, observe, screenshot, t, visible, onCommittedPage,
}: BrowserPageChromeProps) {
  const { page, screenshot: shot } = useBrowserPage(target, observe, screenshot, listedRevision)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [navigating, setNavigating] = useState(false)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const title = browserTabTitle(page, t('page.untitled'))
  const profile = persistentProfileLabel(page, t('dock.sharedProfile'))
  const committed = page?.url ?? ''
  const address = dirty ? draft : committed
  const live = desktopPageSurfaceOf((globalThis as { dshDesktop?: unknown }).dshDesktop) !== undefined
  const image = pageScreenshotSrc(shot)
  const viewport = useDesktopPageSurface(target, visible !== false && live)
  const busy = navigating || page === undefined

  useEffect(() => {
    if (page !== undefined) onCommittedPage?.(page)
  }, [page, onCommittedPage])

  if (target === undefined) {
    return <div className={css.root} data-browser-page=""><div className={css.empty}>{t('dock.creating')}</div></div>
  }

  const goTo = (url?: string): void => {
    const currentTarget = target
    setNavigating(true)
    void (async () => {
      try {
        const current = openPageOf(await observe(currentTarget))
        if (current === undefined) return
        const dest = url ?? current.url
        try {
          await refresh(currentTarget, current.revision, dest)
        } catch (error) {
          if (!isBrowserRevisionConflict(error)) throw error
          const again = openPageOf(await observe(currentTarget))
          if (again === undefined) return
          await refresh(currentTarget, again.revision, dest)
        }
        setDirty(false)
        setActionError(undefined)
      } catch {
        // Observe/navigate can reject when the Session binding dropped
        // or the Runtime closed the tab; occupancy stays on the last
        // committed chrome until the listing revision changes.
        setActionError(t('dock.actionFailed'))
      } finally {
        setNavigating(false)
      }
    })()
  }

  const onSubmitAddress = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (page === undefined) return
    const url = resolveBrowserAddress(address)
    if (url === undefined) {
      setActionError(t('dock.invalidAddress'))
      return
    }
    goTo(url)
  }

  return (
    <div className={css.root} data-browser-page="">
      {actionError !== undefined && <div className={css.actionError} role="alert">{actionError}</div>}
      <div className={css.toolbar}>
        <button
          type="button"
          className={css.tool}
          data-busy={busy || undefined}
          aria-label={busy ? t('dock.refreshing') : t('dock.refresh')}
          aria-busy={busy || undefined}
          disabled={page === undefined || navigating}
          onClick={() => {
            /* v8 ignore next -- the button is disabled until observe returns an open page. */
            if (page === undefined || navigating) return
            goTo()
          }}
        >
          <IconRefreshOutline16 />
        </button>
        <form className={css.address} onSubmit={onSubmitAddress}>
          {profile !== undefined && <span className={css.profile}>{profile}</span>}
          <input
            className={css.url}
            value={address}
            aria-label={t('dock.address')}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              setDirty(true)
              setDraft(event.target.value)
            }}
          />
        </form>
      </div>
      <div
        ref={viewport}
        className={css.viewport}
        data-browser-viewport=""
        data-browser-live={live ? '' : undefined}
      >
        {image !== undefined && <img className={css.screenshot} src={image} alt={title} />}
        {image === undefined && !live && (
          <>
            <div className={css.empty}>{page === undefined ? t('dock.empty') : t('dock.start')}</div>
            {page !== undefined && page.text !== '' && <div className={css.text}>{page.text}</div>}
          </>
        )}
        {image === undefined && live && (
          <div className={css.empty}>{page === undefined ? t('dock.empty') : t('dock.start')}</div>
        )}
      </div>
    </div>
  )
}

/** Open-page facts used by tests that drive chrome without a live Runtime. */
export type { BrowserPageState }
