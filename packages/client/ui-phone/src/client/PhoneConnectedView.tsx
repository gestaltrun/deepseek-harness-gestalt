/**
 * Connected phone tab body (locked design states ③④): the BrowserView-
 * rhythm devbar (device dropdown + the active-format chip), the 1:2 fixed-ratio
 * live frame centered in the panel, the circular Back/Home/Recents/
 * screenshot toolbar, and the error cards whose copy states the next
 * action. Everything reactive arrives through one per-tab
 * `PhoneConnectionController`; the component only mirrors its snapshot.
 */
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { PhoneConnectionController, PhoneStreamFailureKind } from './phone-connection.ts'
import type { PhoneListingSource } from './registry.ts'
import { PhoneH264PlaybackOwner, PhoneH264Surface } from './PhoneH264Surface.tsx'
import css from './PhoneConnectedView.module.css'
import shared from './PhoneShared.module.css'

/** Props of one connected device tab body. */
export interface PhoneConnectedViewProps {
  /** Device the tab streams (Android serial or iOS UDID). */
  readonly serial: string
  /** Display name shown in the dropdown and the copy. */
  readonly name: string
  /** Whether this tab is active and the panel open; false suspends pulling. */
  readonly visible: boolean
  /** Listing source backing the device dropdown. */
  readonly source: PhoneListingSource
  /** Switch the single tab onto another listed device in place (U1). */
  readonly onOpenDevice: (serial: string, name: string) => void
  /** Controller factory; the tab owns the created instance for its lifetime. */
  readonly createController: (serial: string) => PhoneConnectionController
}

/** Error-card copy per failure kind, in the design's next-action semantics. */
const FAILURE_COPY: Record<PhoneStreamFailureKind, {
  readonly tone: 'warn' | 'err'
  readonly title: string
  readonly detail: (name: string) => string
}> = {
  unauthorized: {
    tone: 'warn',
    title: '真机未授权调试',
    detail: name => `${name} 已通过 USB 连接；请在手机上允许「USB 调试」后重新连接。`,
  },
  'device-offline': {
    tone: 'err',
    title: '设备已离线',
    detail: name => `${name} 已从设备清单消失；请重新连接设备后再试。`,
  },
  interrupted: {
    tone: 'err',
    title: '画面流中断',
    detail: () => '自动重连多次未能恢复画面；请手动重试一次。',
  },
  refused: {
    tone: 'err',
    title: '画面流被拒绝',
    detail: () => '宿主拒绝了本次画面会话；请稍后重试。',
  },
  unavailable: {
    tone: 'err',
    title: '无法连接设备画面',
    detail: () => '画面服务暂时不可达；请确认宿主服务正在运行。',
  },
}

/** Pointer travel (px) below which a press still counts as a tap. */
const DRAG_THRESHOLD_PX = 6

/** The toolbar icon glyphs, drawn inline to stay on the primitives idiom. */
function ChevronDown(): ReactNode {
  return (
    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

interface ReconnectAlertProps {
  readonly tone: 'warn' | 'err'
  readonly title: string
  readonly detail: string
  readonly onReconnect: () => void
}

function ReconnectAlert({ tone, title, detail, onReconnect }: ReconnectAlertProps): ReactNode {
  return (
    <div role="alert" className={`${css.alertCard} ${tone === 'warn' ? css.alertWarn : css.alertErr}`}>
      <p className={css.alertTitle}>{title}</p>
      <p className={css.alertDetail}>{detail}</p>
      <div className={css.alertActions}>
        <button type="button" className={shared.minibtnPrimary} onClick={onReconnect}>
          重新连接
        </button>
      </div>
    </div>
  )
}

/**
 * Render the connected body for one device tab.
 * @param props - the device identity, visibility, fleet list, and callbacks.
 * @returns the live view, its in-flight notes, or the error card.
 */
export function PhoneConnectedView({
  serial, name, visible, source, onOpenDevice, createController,
}: PhoneConnectedViewProps): ReactNode {
  const createControllerRef = useRef(createController)
  const h264PlaybackOwnerRef = useRef<PhoneH264PlaybackOwner | undefined>(undefined)
  const h264PlaybackOwner = h264PlaybackOwnerRef.current ??= new PhoneH264PlaybackOwner()
  createControllerRef.current = createController
  // The tab is a singleton (U1): a serial change disposes the previous
  // controller and mints a new session for the chosen device.
  const controller = useMemo(() => createControllerRef.current(serial), [serial])
  // The controller and the listing source are the owning observables; uSES
  // is the render-side adapter (the better-sidebar tab hosts have no slot
  // hook channel).
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const snapshot = useCallback(() => controller.snapshot(), [controller])
  const phase = useSyncExternalStore(subscribe, snapshot, snapshot)
  const listSubscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const listSnapshot = useCallback(() => source.snapshot(), [source])
  const listing = useSyncExternalStore(listSubscribe, listSnapshot, listSnapshot)
  const devices = useMemo(() => [...listing.android, ...listing.ios], [listing])
  const switchable = useMemo(() => devices.filter(device => device.online), [devices])
  const [menuOpen, setMenuOpen] = useState(false)
  /** The press being tracked: its fixed origin, the move trail, the drag flag. */
  const drag = useRef<{
    readonly origin: { u: number; v: number; clientX: number; clientY: number }
    last: { u: number; v: number }
    dragging: boolean
  } | undefined>(undefined)

  useEffect(() => { controller.setVisible(visible) }, [controller, visible])
  useEffect(() => () => { controller.dispose() }, [controller])
  useEffect(() => {
    // The dropdown needs the fleet even when this tab restored from layout
    // without the picker having pulled first; a failed pull keeps the
    // committed listing.
    source.refresh().catch(() => undefined)
  }, [source])

  const normalize = (event: ReactPointerEvent<HTMLDivElement>): { u: number; v: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      u: rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width,
      v: rect.height === 0 ? 0 : (event.clientY - rect.top) / rect.height,
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = normalize(event)
    drag.current = {
      origin: { ...point, clientX: event.clientX, clientY: event.clientY },
      last: point,
      dragging: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === undefined) return
    if (!state.dragging
      && Math.hypot(event.clientX - state.origin.clientX, event.clientY - state.origin.clientY)
        < DRAG_THRESHOLD_PX) {
      return
    }
    state.dragging = true
    state.last = normalize(event)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    drag.current = undefined
    if (state === undefined) return
    const point = normalize(event)
    if (state.dragging) controller.swipe([state.origin, point])
    else controller.tap(point.u, point.v)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length === 1) {
      controller.text(event.key)
      event.preventDefault()
      return
    }
    if (event.key === 'Enter') {
      controller.text('\n')
      event.preventDefault()
    }
  }

  const current = devices.find(device => device.id === serial)
  const online = current?.online === true
  const unauthorized = current?.state === 'unauthorized'

  const screenContent = (): ReactNode => {
    // A listed-unauthorized handset cannot stream: the design's warn arm
    // replaces the stream area (a live stream wins — the device may have
    // been authorized since the listing committed).
    if (unauthorized && phase.kind !== 'live') {
      const copy = FAILURE_COPY.unauthorized
      return (
        <ReconnectAlert
          tone={copy.tone}
          title={copy.title}
          detail={copy.detail(name)}
          onReconnect={() => { controller.connect() }}
        />
      )
    }
    if (phase.kind === 'live') {
      const surface = phase.format === 'h264'
        ? (
          <PhoneH264Surface
            owner={h264PlaybackOwner}
            label={`${name} 实时画面`}
            className={css.stream}
            url={phase.streamUrl}
            onSurface={(width, height) => { controller.noteSurface('h264', width, height) }}
            onError={() => { controller.noteCaptureFailure('h264') }}
          />
        )
        : (
          <img
            src={phase.streamUrl}
            alt={`${name} 实时画面`}
            className={css.stream}
            draggable={false}
            onLoad={(event) => {
              controller.noteSurface('mjpeg', event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
            }}
            onError={() => { controller.noteCaptureFailure('mjpeg') }}
          />
        )
      return (
        <div
          role="application"
          aria-label={`${name} 画面，点击发送触控，按住拖动为滑动，键入发送文本`}
          tabIndex={0}
          className={css.screenFrame}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
        >
          {surface}
          <span className={css.liveFlag}>
            <span aria-hidden="true" className={css.liveDot} />
            代理中
          </span>
        </div>
      )
    }
    if (phase.kind === 'connecting' || phase.kind === 'reconnecting') {
      return (
        <div className={css.statusNote}>
          <span aria-hidden="true" className={css.spinner} />
          {phase.kind === 'connecting'
            ? '正在连接画面…'
            : `画面重连中（第 ${phase.attempt} 次尝试）…`}
        </div>
      )
    }
    if (phase.kind === 'error') {
      const copy = FAILURE_COPY[phase.failure.kind]
      return (
        <ReconnectAlert
          tone={copy.tone}
          title={copy.title}
          detail={copy.detail(name)}
          onReconnect={() => { controller.connect() }}
        />
      )
    }
    return (
      <div className={css.statusNote}>
        {phase.kind === 'suspended' ? '已暂停——回到此标签页时恢复画面。' : '未连接。'}
      </div>
    )
  }

  return (
    <div className={css.view}>
      <div className={css.devbar}>
        <button
          type="button"
          className={css.devpick}
          aria-label={`切换设备：${name}`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => { setMenuOpen(open => !open) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMenuOpen(false)
          }}
        >
          <span
            aria-hidden="true"
            className={clsx(css.dot, unauthorized && css.dotUnauthorized, !online && !unauthorized && css.dotOffline)}
          />
          {name}
          <ChevronDown />
        </button>
        <span className={css.devbarSpacer} />
        {/* The H264 cadence is the locked mockup's caption; the stream
            contract carries no fps field, so MJPEG names only its encoding. */}
        <span
          className={`${css.tierChip} ${css.tierChipActive}`}
          aria-label={phase.kind === 'live' && phase.format === 'mjpeg'
            ? '当前画面编码 MJPEG'
            : '当前画面编码 H264 · 30 fps'}
        >
          <span aria-hidden="true" className={css.liveDot} />
          {phase.kind === 'live' && phase.format === 'mjpeg' ? 'MJPEG' : 'H264'}
          {!(phase.kind === 'live' && phase.format === 'mjpeg') && <span className={css.reslv}>30 fps</span>}
        </span>
        {menuOpen && (
          <div role="menu" aria-label="切换设备" className={css.pickMenu}>
            {switchable.map(device => (
              <button
                key={device.id}
                type="button"
                role="menuitem"
                className={css.pickItem}
                onClick={() => {
                  setMenuOpen(false)
                  if (device.id !== serial) onOpenDevice(device.id, device.name)
                }}
              >
                <span aria-hidden="true" className={css.dot} />
                {device.name}
                <span className={css.pickMeta}>{device.id === serial ? '当前 ✓' : '切换'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={css.screenArea}>
        {screenContent()}
      </div>

      <div className={css.toolstrip}>
        <button type="button" className={css.iconButton} aria-label="返回" onClick={() => { controller.button('BACK') }}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className={css.iconButton} aria-label="主屏幕" onClick={() => { controller.button('HOME') }}>
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        <button type="button" className={css.iconButton} aria-label="最近任务" onClick={() => { controller.button('RECENTS') }}>
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="11" width="4.6" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
            <rect x="9.9" y="6" width="4.6" height="12" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
            <rect x="15.8" y="9" width="4.6" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
          </svg>
        </button>
        <span aria-hidden="true" className={css.toolSep} />
        <button
          type="button" className={css.iconButton} aria-label="截图" disabled
          title="截图将随后续票据存入会话附件"
        >
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M4 8.5h3l1.6-2.4h6.8L17 8.5h3v10H4v-10Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="12" cy="13.4" r="3" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        <button type="button" className={css.iconButton} aria-label="刷新流" onClick={() => { controller.refresh() }}>
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M20 4v4.5h-4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M4 20v-4.5h4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className={css.hintline}>点击画面即向设备发送触控；按住拖动为滑动。画面左上角显示当前操作方（你 / Agent）。</div>
    </div>
  )
}
