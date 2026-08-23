/**
 * Collapsed Browser preview: bare offset tab layers in the conversation
 * right gutter. ChatView hides the rail when that gutter is too narrow.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserWorkspaceProjection } from '@deepseek-ai/dsh-browser-workspace/client'
import type { BrowserPreviewActions } from './slots.ts'
import {
  browserAddressHost, browserTabTitle, hasBrowserTabs, pageScreenshotSrc, selectBrowserPreview,
  stackedBrowserTabs,
} from './model.ts'
import { useBrowserPage } from './use-browser-page.ts'
import { recoverListedMutation } from './listed-mutation.ts'
import css from './BrowserPreview.module.css'

/** Complete preview-slot props. */
export type BrowserPreviewProps =
  PropsRuntime<'conversation.browser.preview'>
  & PropsLocale<'browser'>
  & BrowserPreviewActions

/**
 * Layered tab preview shown while this Session owns Browser tabs. A back
 * layer focuses that tab with its listed revision; the current layer opens
 * the workbench browser tab. A back-layer `BROWSER_REVISION_CONFLICT`
 * observes once and retries. The current layer re-observes when that listed
 * revision advances.
 */
export function BrowserPreview({
  useProjection, reveal, focus, observe, screenshot, t,
}: BrowserPreviewProps) {
  const snapshot = useProjection('browserWorkspace') as BrowserWorkspaceProjection | null | undefined
  const selection = selectBrowserPreview(snapshot)
  const active = selection?.activeTab
  const { page, screenshot: shot } = useBrowserPage(
    active?.target, observe, screenshot, active?.revision,
  )
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  if (!hasBrowserTabs(snapshot) || selection === undefined) return null

  const layers = stackedBrowserTabs(selection.tabs)
  const title = browserTabTitle(page, t('page.untitled'))
  const address = page === undefined ? '' : browserAddressHost(page.url)
  const image = pageScreenshotSrc(shot)
  const currentCaption = address === '' ? title : `${title} · ${address}`

  return (
    <div className={css.stack} data-browser-preview="">
      {layers.map((tab, index) => {
        const current = tab.active
        return (
          <button
            key={tab.target.tabId}
            type="button"
            className={css.layer}
            data-active={current || undefined}
            style={{ zIndex: index }}
            aria-label={current ? t('preview.open', { title }) : t('preview.select', { title })}
            onClick={() => {
              if (current) {
                reveal()
                return
              }
              void recoverListedMutation(focus, observe, tab.target, tab.revision)
                .then(() => { setActionError(undefined) })
                .catch(() => { setActionError(t('dock.actionFailed')) })
            }}
          >
            {image !== undefined && <img className={css.shot} src={image} alt="" />}
            <span className={css.caption}>{current ? currentCaption : t('page.untitled')}</span>
          </button>
        )
      })}
      {actionError !== undefined && <div className={css.actionError} role="alert">{actionError}</div>}
    </div>
  )
}
