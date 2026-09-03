/**
 * Official page chrome for one Session-owned page.
 * The workbench sidebar tab bar is the page list; this pane has no tab strip.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconLinkOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Replaces a projected target absent from the current Runtime. */
  onMissingTarget?: (target: BrowserTarget) => BrowserPageState | undefined | Promise<BrowserPageState | undefined>
  /** Create failure for an unbound tab; switches the placeholder to a retry affordance. */
  createError?: string
  /** Retry the failed page create. */
  onRetry?: () => void
}

/**
 * Address bar and live-or-screenshot viewport for one page.
 * @param props - Session-bound remotes and the page identity.
 * @returns the chrome tree, or a creating placeholder when the target is absent.
 */
export function BrowserPageChrome({
  target, listedRevision, refresh, observe, screenshot, t, visible, onCommittedPage, onMissingTarget,
  createError, onRetry,
}: BrowserPageChromeProps) {
  const { page, screenshot: shot } = useBrowserPage(
    target,
    observe,
    screenshot,
    listedRevision,
    onMissingTarget,
  )
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

  // Chrome-local back/forward trail. The Runtime owns no history verbs, so
  // the pane records every committed URL (address-bar navigations and, on
  // Desktop, in-page link clicks observed after a revision advance) and
  // revisits entries through the same navigate path.
  const historyRef = useRef<string[]>([])
  const cursorRef = useRef(-1)
  const [trail, setTrail] = useState({ size: 0, cursor: -1 })
  useEffect(() => {
    const url = page?.url
    if (url === undefined || url === '' || url === 'about:blank') return
    if (historyRef.current[cursorRef.current] === url) return
    historyRef.current = [...historyRef.current.slice(0, cursorRef.current + 1), url]
    cursorRef.current += 1
    setTrail({ size: historyRef.current.length, cursor: cursorRef.current })
  }, [page?.url])

  if (target === undefined) {
    if (createError === undefined) {
      return <div className={css.root} data-browser-page=""><div className={css.empty}>{t('dock.creating')}</div></div>
    }
    return (
      <div className={css.root} data-browser-page="">
        <div className={css.empty} role="alert">{t('dock.createFailed')}</div>
        <div className={css.createError}>{createError}</div>
        {onRetry !== undefined && (
          <button type="button" className={css.retry} onClick={onRetry}>{t('dock.retry')}</button>
        )}
      </div>
    )
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

  // Moving the cursor before goTo keeps the observe effect from appending
  // the revisited URL as a new entry.
  const goHistory = (offset: -1 | 1): void => {
    const next = cursorRef.current + offset
    const url = historyRef.current[next]
    if (url === undefined || page === undefined || navigating) return
    cursorRef.current = next
    setTrail({ size: historyRef.current.length, cursor: next })
    goTo(url)
  }

  const openExternal = (): void => {
    const url = page?.url
    if (url === undefined || url === '' || url === 'about:blank') return
    window.open(url, '_blank', 'noopener')
  }

  const canGoBack = trail.cursor > 0
  const canGoForward = trail.cursor >= 0 && trail.cursor < trail.size - 1

  return (
    <div className={css.root} data-browser-page="">
      {actionError !== undefined && <div className={css.actionError} role="alert">{actionError}</div>}
      <div className={css.toolbar}>
        <button
          type="button"
          className={css.tool}
          aria-label={t('dock.back')}
          disabled={!canGoBack || page === undefined || navigating}
          onClick={() => { goHistory(-1) }}
        >
          <IconChevronLeftOutline14 />
        </button>
        <button
          type="button"
          className={css.tool}
          aria-label={t('dock.forward')}
          disabled={!canGoForward || page === undefined || navigating}
          onClick={() => { goHistory(1) }}
        >
          <IconChevronRightOutline14 />
        </button>
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
        <button
          type="button"
          className={css.tool}
          aria-label={t('dock.openExternal')}
          disabled={page === undefined || page.url === '' || page.url === 'about:blank'}
          onClick={openExternal}
        >
          <IconLinkOutline16 />
        </button>
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
