/**
 * Connected phone tab body (locked design states ③④): the BrowserView-
 * rhythm devbar (device dropdown + the active-format chip), the live frame
 * centered in the panel at the measured surface aspect (the locked 1:2
 * ratio is only the pre-measurement placeholder), the circular
 * Back/Home/Recents/screenshot toolbar, and the error cards whose copy
 * states the next action. Everything reactive arrives through one per-tab
 * `PhoneConnectionController`; the component only mirrors its snapshot.
 */
import clsx from 'clsx'
import type { PhoneCaptureId } from '@deepseek-ai/dsh-phone-runtime'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from 'react'
import {
  type PhoneConnectionController,
  type PhoneConnectionPhase,
  type PhoneCoordinateUnavailableReason,
  type PhoneStreamFailureKind,
  type PhoneSurfaceSize,
} from './phone-connection.ts'
import { startPhoneListingPoll } from './phone-listing-poll.ts'
import type { PhoneListingSource } from './registry.ts'
import { measureMjpegCurrentFrame } from './measure-mjpeg-current-frame.ts'
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
  /** Clear occupation so the picker with 重新检测环境 renders again. */
  readonly onShowPicker: () => void
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
  'agent-missing': {
    tone: 'warn',
    title: '设备控制代理未安装',
    detail: () => '安装后设备才能稳定接收点击、拖拽与文本操作；Android 会通过 USB 安装，iPhone 会使用 Host 当前配置的签名描述文件。',
  },
  'agent-install-restricted': {
    tone: 'warn',
    title: '设备拒绝安装控制代理',
    detail: () => '请保持手机解锁，并在开发者选项中允许「USB 安装」与「USB 调试（安全设置）」后重试。系统确认必须在手机上完成。',
  },
  'agent-profile-required': {
    tone: 'warn',
    title: '未配置真机签名描述文件',
    detail: () => '请打开配置文件，为 phone-runtime 选择可用的 provisioningProfilePath，再返回此处安装；产品不会自动创建签名 identity 或 provisioning profile。',
  },
  'device-locked': {
    tone: 'warn',
    title: 'iPhone 已锁定',
    detail: () => '请解锁 iPhone、保持屏幕常亮，再重新连接。产品不会代替你输入设备密码。',
  },
  'cert-untrusted': {
    tone: 'warn',
    title: '设备控制代理未受信任',
    detail: () => '请在 iPhone 上启用 Developer Mode，并按系统提示信任开发者证书；签名 identity、provisioning 与信任仍需你在 Xcode 和设备上完成。',
  },
  'profile-expired': {
    tone: 'warn',
    title: '签名描述文件已过期',
    detail: () => '请先在配置中选择当前可用的 provisioning profile，再重新安装设备控制代理；免费团队签名通常需要定期续签。',
  },
  'tunnel-failed': {
    tone: 'err',
    title: '真机连接通道未建立',
    detail: () => '请保持 iPhone 解锁、已信任此 Mac 且数据线连接稳定，然后重新连接。',
  },
  'device-unplugged': {
    tone: 'err',
    title: 'iPhone 已断开连接',
    detail: () => '请重新连接数据线并确认设备重新出现在清单中。',
  },
}

/** Pointer travel (px) below which a press still counts as a tap. */
const DRAG_THRESHOLD_PX = 6
/** Idle gap after which a trackpad wheel burst becomes one vertical swipe. */
const WHEEL_BURST_IDLE_MS = 50
/** Pixel travel of one `DOM_DELTA_LINE` wheel unit on the live frame. */
const WHEEL_LINE_PX = 16
/** Minimum normalized vertical travel of a coalesced wheel swipe. */
const WHEEL_MIN_TRAVEL = 0.08
/** Maximum normalized vertical travel of a coalesced wheel swipe. */
const WHEEL_MAX_TRAVEL = 0.4
/**
 * Re-measure cadence for a live MJPEG image. Chromium keeps
 * `naturalWidth`/`naturalHeight` at the first `multipart/x-mixed-replace`
 * JPEG, so the interval reads the currently painted bitmap.
 */
const MJPEG_SURFACE_POLL_MS = 500

/** The toolbar icon glyphs, drawn inline to stay on the primitives idiom. */
/** Devbar encoding/status chip derived from the controller phase and painted surface. */
interface PlaybackChip {
  readonly ariaLabel: string
  readonly label: string
  readonly caption?: string
  readonly playing: boolean
}

/**
 * Name playback from the existing connection owner and decoded first frame.
 * Socket-open `live` without `surfaceSize` is waiting, not playing. The stream
 * contract has no fps field, so the chip never invents a measured cadence.
 */
function playbackChipOf(
  phase: PhoneConnectionPhase,
  surfaceSize: PhoneSurfaceSize | undefined,
  online: boolean,
): PlaybackChip {
  if (phase.kind === 'connecting' || phase.kind === 'checking-agent' || phase.kind === 'repairing-agent') {
    return { ariaLabel: '画面状态 正在连接', label: '连接中', playing: false }
  }
  if (phase.kind === 'reconnecting') {
    return { ariaLabel: '画面状态 正在重连', label: '重连中', playing: false }
  }
  if (phase.kind === 'error') {
    return { ariaLabel: '画面状态 画面错误', label: '错误', playing: false }
  }
  if (phase.kind === 'suspended') {
    return { ariaLabel: '画面状态 已暂停', label: '已暂停', playing: false }
  }
  if (phase.kind === 'idle') {
    return {
      ariaLabel: online ? '画面状态 设备在线' : '画面状态 未连接',
      label: online ? '在线' : '未连接',
      playing: false,
    }
  }
  const encoding = phase.format === 'mjpeg' ? 'MJPEG' : 'H264'
  if (surfaceSize === undefined) {
    return { ariaLabel: `画面状态 等待 ${encoding} 首帧`, label: '等待首帧', caption: encoding, playing: false }
  }
  return { ariaLabel: `当前画面编码 ${encoding}`, label: encoding, playing: true }
}

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
  readonly agentRecovery?: 'install' | 'reinstall'
  readonly onRecoverAgent?: (force: boolean) => void
}

function ReconnectAlert({
  tone, title, detail, onReconnect, agentRecovery, onRecoverAgent,
}: ReconnectAlertProps): ReactNode {
  return (
    <div role="alert" className={`${css.alertCard} ${tone === 'warn' ? css.alertWarn : css.alertErr}`}>
      <p className={css.alertTitle}>{title}</p>
      <p className={css.alertDetail}>{detail}</p>
      <div className={css.alertActions}>
        {agentRecovery !== undefined && onRecoverAgent !== undefined && (
          <button
            type="button"
            className={shared.minibtnPrimary}
            onClick={() => { onRecoverAgent(agentRecovery === 'reinstall') }}
          >
            {agentRecovery === 'install' ? '安装设备控制代理' : '重新安装设备控制代理'}
          </button>
        )}
        <button
          type="button"
          className={agentRecovery === undefined ? shared.minibtnPrimary : shared.minibtnSecondary}
          onClick={onReconnect}
        >
          {agentRecovery === undefined ? '重新连接' : '重新检测'}
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
  serial, name, visible, source, onOpenDevice, onShowPicker, createController,
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
  const surfaceSnapshot = useCallback(() => controller.surfaceSize(), [controller])
  const surfaceSize = useSyncExternalStore(subscribe, surfaceSnapshot, surfaceSnapshot)
  const rotationSnapshot = useCallback(() => controller.surfaceOrientation(), [controller])
  const surfaceRotation = useSyncExternalStore(subscribe, rotationSnapshot, rotationSnapshot)
  const actionSnapshot = useCallback(() => controller.actionStatus(), [controller])
  const actionFailure = useSyncExternalStore(subscribe, actionSnapshot, actionSnapshot)
  const coordinateSnapshot = useCallback(() => controller.coordinateUnavailableReason(), [controller])
  const coordinateUnavailable = useSyncExternalStore(subscribe, coordinateSnapshot, coordinateSnapshot)
  const listSubscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const listSnapshot = useCallback(() => source.snapshot(), [source])
  const listing = useSyncExternalStore(listSubscribe, listSnapshot, listSnapshot)
  const devices = useMemo(() => [...listing.android, ...listing.ios], [listing])
  const current = devices.find(device => device.id === serial)
  const androidLogicalDisplay = listing.android.find(device => device.id === serial)?.logicalDisplay
  const occupyingPlatform = listing.android.some(device => device.id === serial)
    ? 'android' as const
    : listing.ios.some(device => device.id === serial) ? 'ios' as const : undefined
  const switchable = useMemo(() => devices.filter(device => device.online), [devices])
  const [menuOpen, setMenuOpen] = useState(false)
  /** The press being tracked: its fixed origin, the move trail, the drag flag. */
  const drag = useRef<{
    readonly pointerId: number
    readonly target: HTMLDivElement
    readonly origin: { u: number; v: number; clientX: number; clientY: number }
    readonly trail: Array<{ u: number; v: number }>
    dragging: boolean
  } | undefined>(undefined)
  const wheel = useRef<{
    deltaY: number
    surfaceHeight: number
    handle: ReturnType<typeof setTimeout>
  } | undefined>(undefined)
  /** The live MJPEG image; its currently painted JPEG is re-measured on a cadence. */
  const mjpegImg = useRef<HTMLImageElement | null>(null)
  /** Drops an in-flight current-frame measurement after a newer one starts or MJPEG leaves live. */
  const mjpegMeasureGeneration = useRef(0)
  const releaseDrag = useCallback((): void => {
    const state = drag.current
    drag.current = undefined
    if (state?.target.hasPointerCapture(state.pointerId) === true) {
      state.target.releasePointerCapture(state.pointerId)
    }
  }, [])

  const releaseWheel = useCallback((): void => {
    if (wheel.current !== undefined) clearTimeout(wheel.current.handle)
    wheel.current = undefined
  }, [])

  useEffect(() => {
    if (occupyingPlatform !== undefined) controller.notePlatform(occupyingPlatform)
    controller.noteLogicalDisplay(androidLogicalDisplay)
  }, [androidLogicalDisplay, occupyingPlatform, controller])
  useEffect(() => { controller.setVisible(visible) }, [controller, visible])
  useEffect(() => () => {
    releaseDrag()
    releaseWheel()
    controller.dispose()
  }, [controller, releaseDrag, releaseWheel])
  const liveStreamUrl = phase.kind === 'live' ? phase.streamUrl : undefined
  const surfaceIdentity = phase.kind === 'live' && surfaceSize !== undefined
    ? `${phase.captureId}:${String(surfaceSize.width)}:${String(surfaceSize.height)}:${String(surfaceRotation)}`
    : undefined
  useEffect(() => () => {
    releaseDrag()
    releaseWheel()
  }, [liveStreamUrl, releaseDrag, releaseWheel, surfaceIdentity, visible])
  useEffect(() => {
    // The dropdown needs the fleet even when this tab restored from layout
    // without the picker having pulled first; a failed pull keeps the
    // committed listing.
    source.refresh().catch(() => undefined)
  }, [source])
  useEffect(() => startPhoneListingPoll(source), [source])

  const mjpegLive = phase.kind === 'live' && phase.format === 'mjpeg'
  const applyMjpegSurface = useCallback((img: HTMLImageElement, captureId: PhoneCaptureId): void => {
    const token = ++mjpegMeasureGeneration.current
    void measureMjpegCurrentFrame(img).then((size) => {
      if (token !== mjpegMeasureGeneration.current || size === undefined) return
      controller.noteSurface('mjpeg', captureId, size.width, size.height)
    })
  }, [controller])

  useEffect(() => {
    if (!mjpegLive) return
    const captureId = phase.captureId
    const measure = (): void => {
      // The effect lives only while the live MJPEG phase renders the image;
      // its cleanup clears the interval before the ref can detach.
      const img = mjpegImg.current as HTMLImageElement
      applyMjpegSurface(img, captureId)
    }
    measure()
    const handle = setInterval(measure, MJPEG_SURFACE_POLL_MS)
    return () => {
      mjpegMeasureGeneration.current += 1
      clearInterval(handle)
    }
  }, [applyMjpegSurface, mjpegLive])

  const normalize = (event: ReactPointerEvent<HTMLDivElement>): { u: number; v: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      u: rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width,
      v: rect.height === 0 ? 0 : (event.clientY - rect.top) / rect.height,
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = normalize(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      origin: { ...point, clientX: event.clientX, clientY: event.clientY },
      trail: [],
      dragging: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    state.trail.push(normalize(event))
    if (!state.dragging
      && Math.hypot(event.clientX - state.origin.clientX, event.clientY - state.origin.clientY)
        < DRAG_THRESHOLD_PX) {
      return
    }
    state.dragging = true
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    drag.current = undefined
    state.target.releasePointerCapture(event.pointerId)
    const point = normalize(event)
    const dragging = state.dragging
      || Math.hypot(event.clientX - state.origin.clientX, event.clientY - state.origin.clientY) >= DRAG_THRESHOLD_PX
    if (dragging) controller.swipe([state.origin, ...state.trail, point])
    else controller.tap(point.u, point.v)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    drag.current = undefined
    state.target.releasePointerCapture(event.pointerId)
  }

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (event.deltaY === 0) return
    event.preventDefault()
    const surfaceHeight = event.currentTarget.getBoundingClientRect().height
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? surfaceHeight : 1
    const deltaY = (wheel.current?.deltaY ?? 0) + event.deltaY * unit
    if (wheel.current !== undefined) clearTimeout(wheel.current.handle)
    const handle = setTimeout(() => {
      wheel.current = undefined
      const travel = Math.min(WHEEL_MAX_TRAVEL, Math.max(WHEEL_MIN_TRAVEL, Math.abs(deltaY) / Math.max(1, surfaceHeight)))
      const direction = Math.sign(deltaY)
      controller.swipe([
        { u: 0.5, v: 0.5 + direction * travel / 2 },
        { u: 0.5, v: 0.5 - direction * travel / 2 },
      ])
    }, WHEEL_BURST_IDLE_MS)
    wheel.current = { deltaY, surfaceHeight, handle }
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

  const online = current?.online === true
  const unauthorized = current?.state === 'unauthorized'
  const chip = playbackChipOf(phase, surfaceSize, online)

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
            onSurface={(width, height, rotation) => {
              controller.noteSurface('h264', phase.captureId, width, height, rotation)
            }}
            onError={() => { controller.noteCaptureFailure('h264', phase.captureId) }}
          />
        )
        : (
          <img
            ref={mjpegImg}
            src={phase.streamUrl}
            alt={`${name} 实时画面`}
            className={css.stream}
            draggable={false}
            onLoad={(event) => { applyMjpegSurface(event.currentTarget, phase.captureId) }}
            onError={() => { controller.noteCaptureFailure('mjpeg', phase.captureId) }}
          />
        )
      // The box follows the measured surface aspect; before the first
      // measurement the stylesheet's `--phone-surface-ratio` fallback keeps
      // the locked 1:2 placeholder. An exact-ratio box plus
      // `object-fit: contain` maps frames without distorting pixels.
      const frameStyle = surfaceSize === undefined
        ? undefined
        : { '--phone-surface-ratio': String(surfaceSize.width / surfaceSize.height) } as CSSProperties
      const coordinateIo = coordinateUnavailable === undefined
      return (
        <div
          role="application"
          aria-label={coordinateIo
            ? `${name} 画面，点击发送触控，按住拖动或触控板滚动为滑动，键入发送文本`
            : `${name} 画面，触控坐标平面不可用`}
          tabIndex={0}
          className={css.screenFrame}
          style={frameStyle}
          onPointerDown={coordinateIo ? onPointerDown : undefined}
          onPointerMove={coordinateIo ? onPointerMove : undefined}
          onPointerUp={coordinateIo ? onPointerUp : undefined}
          onPointerCancel={coordinateIo ? onPointerCancel : undefined}
          onWheel={coordinateIo ? onWheel : undefined}
          onKeyDown={onKeyDown}
        >
          {surface}
          <span className={css.liveFlag}>
            {chip.playing ? <span aria-hidden="true" className={css.liveDot} /> : undefined}
            {chip.playing ? '代理中' : '等待首帧'}
          </span>
          {coordinateUnavailable === 'missing-logical'
            || coordinateUnavailable === 'orientation-mismatch'
            || coordinateUnavailable === 'unknown-platform'
            ? <span role="status" className={css.actionError}>{coordinateUnavailableCopy(coordinateUnavailable)}</span>
            : undefined}
          {actionFailure !== undefined && (
            <span role="status" className={css.actionError}>操作失败：{actionFailure.message}</span>
          )}
        </div>
      )
    }
    if (phase.kind === 'connecting' || phase.kind === 'reconnecting'
      || phase.kind === 'checking-agent' || phase.kind === 'repairing-agent') {
      return (
        <div className={css.statusNote}>
          <span aria-hidden="true" className={css.spinner} />
          {phase.kind === 'connecting' ? '正在连接画面…'
            : phase.kind === 'reconnecting' ? `画面重连中（第 ${phase.attempt} 次尝试）…`
              : phase.kind === 'checking-agent' ? '正在检测设备控制代理…'
                : phase.force ? '正在重新安装设备控制代理…' : '正在安装设备控制代理…'}
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
          {...(phase.failure.agentRecovery === undefined ? {} : { agentRecovery: phase.failure.agentRecovery })}
          onRecoverAgent={(force) => { controller.recoverAgent(force) }}
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
    <div className={css.view} data-phone-connected>
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
        <button
          type="button"
          className={shared.minibtnSecondary}
          aria-label="选择设备"
          onClick={onShowPicker}
        >
          选择设备
        </button>
        <span className={css.devbarSpacer} />
        <span
          className={clsx(css.tierChip, chip.playing && css.tierChipActive)}
          aria-label={chip.ariaLabel}
        >
          {chip.playing ? <span aria-hidden="true" className={css.liveDot} /> : undefined}
          {chip.label}
          {chip.caption !== undefined ? <span className={css.reslv}>{chip.caption}</span> : undefined}
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
      <div className={css.hintline}>点击画面即向设备发送触控；按住拖动或触控板滚动为滑动。画面左上角显示当前操作方（你 / Agent）。</div>
    </div>
  )
}

function coordinateUnavailableCopy(
  reason: Exclude<PhoneCoordinateUnavailableReason, 'missing-surface'>,
): string {
  switch (reason) {
    case 'missing-logical':
      return '触控不可用：当前设备逻辑尺寸未知'
    case 'orientation-mismatch':
      return '触控不可用：画面与设备逻辑尺寸方向不一致'
    case 'unknown-platform':
      return '触控不可用：设备平台未确认'
  }
}
