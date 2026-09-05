/** React ownership adapter for one canvas-backed H264 playback lifecycle. */
import { useEffect, useRef, type ReactNode } from 'react'
import {
  playPhoneH264Stream, type PhoneH264Playback, type PhoneH264PlaybackOptions,
} from './phone-h264-playback.ts'

/** Serializes H264 playback lifecycles across surface unmounts and replacements. */
export class PhoneH264PlaybackOwner {
  private settlement: Promise<void> | undefined

  /**
   * Start playback after the preceding lifecycle settles and return its synchronous stop request.
   * @param options - canvas, URL, and callbacks for the requested playback.
   * @returns a disposer that prevents a pending start and joins active playback shutdown.
   */
  start(options: PhoneH264PlaybackOptions): () => void {
    let disposed = false
    let playback: PhoneH264Playback | undefined
    const start = (): void => {
      if (disposed) return
      playback = playPhoneH264Stream(options)
    }
    const prior = this.settlement
    let started: Promise<void>
    if (prior === undefined) {
      start()
      started = Promise.resolve()
    } else {
      started = prior.then(start)
    }
    return () => {
      disposed = true
      this.settlement = playback === undefined
        ? started.then(async () => { await playback?.close() })
        : playback.close()
    }
  }
}

/** Props for one decoded H264 canvas. */
export interface PhoneH264SurfaceProps {
  /** Playback owner retained by the connected tab across non-live phases. */
  readonly owner: PhoneH264PlaybackOwner
  /** Signed same-origin Annex-B capture URL. */
  readonly url: string
  /** Accessible name of the visible phone picture. */
  readonly label: string
  /** CSS class applied to the canvas. */
  readonly className: string | undefined
  /** Receives post-rotation display dimensions for touch-coordinate mapping. */
  readonly onSurface: (width: number, height: number, rotation: 0 | 90 | 180 | 270) => void
  /** Receives one terminal playback failure. */
  readonly onError: (error: unknown) => void
}

/**
 * Render one H264 canvas and bind playback lifetime to its URL and mount.
 * @param props - URL, accessible name, styling, and lifecycle callbacks.
 * @returns the canvas that receives decoded frames.
 */
export function PhoneH264Surface(props: PhoneH264SurfaceProps): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const target = canvas.current as HTMLCanvasElement
    return props.owner.start({
      url: props.url,
      canvas: target,
      onSurface: props.onSurface,
      onError: props.onError,
    })
  }, [props.owner, props.url])

  return <canvas ref={canvas} role="img" aria-label={props.label} className={props.className} />
}
