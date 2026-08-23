/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — every piece of text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve to that content (trigger: its own text; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

/** Where the settings panel paints. */
export type SettingsChromeMode = 'web' | 'desktop-host' | 'overlay'

/** Duck-typed Desktop overlay verbs used by the settings trigger. */
interface SettingsDesktopBridge {
  chromeOverlayShow: (request: {
    kind: 'settings'
    requestId: string
    sectionId?: string
  }) => void | Promise<void>
  chromeOverlayGetState: () => Promise<{
    kind?: string
    requestId?: string
    sectionId?: string
  } | null>
  chromeOverlayResult?: (result: { type: 'close'; requestId: string }) => void
  onChromeOverlayState: (listener: (state: {
    kind?: string
    requestId?: string
    sectionId?: string
  } | null) => void) => () => void
  onChromeOverlayResult: (listener: (result: { type: string; requestId: string }) => void) => () => void
}

/**
 * Choose in-page Settings, Host-chrome trigger + native overlay, or overlay panel.
 * @returns the chrome mode for this document.
 */
export function settingsChromeMode(): SettingsChromeMode {
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-dsh-desktop-overlay')) {
    return 'overlay'
  }
  const bridge = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (typeof bridge === 'object' && bridge !== null
    && typeof (bridge as SettingsDesktopBridge).chromeOverlayShow === 'function') {
    return 'desktop-host'
  }
  return 'web'
}

function settingsDesktopBridge(): SettingsDesktopBridge | undefined {
  const bridge = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (typeof bridge !== 'object' || bridge === null) return undefined
  if (typeof (bridge as SettingsDesktopBridge).chromeOverlayShow !== 'function') return undefined
  return bridge as SettingsDesktopBridge
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSections, useOnboardingSteps, useSessions, renderSlot } = props
  const mode = settingsChromeMode()
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const requestId = useRef('')
  const close = useCallback(() => {
    if (mode === 'overlay') {
      settingsDesktopBridge()?.chromeOverlayResult?.({ type: 'close', requestId: requestId.current })
      return
    }
    setOpen(false)
    setActiveId(undefined)
  }, [mode])
  useEffect(() => {
    if (mode !== 'web' || !open) return
    window.dispatchEvent(new CustomEvent('dsh-overlay-lock', { detail: { held: true } }))
    return () => {
      window.dispatchEvent(new CustomEvent('dsh-overlay-lock', { detail: { held: false } }))
    }
  }, [mode, open])
  useEffect(() => {
    if (mode !== 'desktop-host') return
    const bridge = settingsDesktopBridge()
    if (bridge === undefined || typeof bridge.onChromeOverlayResult !== 'function') return
    return bridge.onChromeOverlayResult((result) => {
      if (result.requestId !== requestId.current || result.type !== 'close') return
      requestId.current = ''
      setOpen(false)
      setActiveId(undefined)
    })
  }, [mode])
  useEffect(() => {
    if (mode !== 'overlay') return
    const bridge = settingsDesktopBridge()
    if (bridge === undefined || typeof bridge.onChromeOverlayState !== 'function') return
    const applyState = (state: { kind?: string; requestId?: string; sectionId?: string } | null): void => {
      if (state?.kind !== 'settings' || typeof state.requestId !== 'string') {
        requestId.current = ''
        setOpen(false)
        setActiveId(undefined)
        return
      }
      requestId.current = state.requestId
      setActiveId(typeof state.sectionId === 'string' ? state.sectionId : undefined)
      setOpen(true)
    }
    void bridge.chromeOverlayGetState().then(applyState)
    return bridge.onChromeOverlayState(applyState)
  }, [mode])
  const openDesktop = useCallback((sectionId?: string) => {
    const id = crypto.randomUUID()
    requestId.current = id
    setActiveId(sectionId)
    setOpen(true)
    void settingsDesktopBridge()?.chromeOverlayShow({
      kind: 'settings',
      requestId: id,
      ...(sectionId === undefined ? {} : { sectionId }),
    })
  }, [])
  const openSection = useCallback((id: string) => {
    if (mode === 'desktop-host') {
      openDesktop(id)
      return
    }
    setActiveId(id)
    setOpen(true)
  }, [mode, openDesktop])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  if (mode === 'overlay') {
    return open ? (
      <SettingsPanel
        rows={rows}
        renderSlot={renderSlot}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={close}
      />
    ) : null
  }

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (mode === 'desktop-host') openDesktop()
          else setOpen(true)
        }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {open && mode === 'web' && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
