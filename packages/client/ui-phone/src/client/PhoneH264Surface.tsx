/** React ownership adapter for one canvas-backed H264 playback lifecycle. */
import { useEffect, useRef, type ReactNode } from 'react'
import { playPhoneH264Stream } from './phone-h264-playback.ts'

/** Props for one decoded H264 canvas. */
export interface PhoneH264SurfaceProps {
  /** Signed same-origin Annex-B capture URL. */
  readonly url: string
  /** Accessible name of the visible phone picture. */
  readonly label: string
  /** CSS class applied to the canvas. */
  readonly className: string | undefined
  /** Receives decoded display dimensions for touch-coordinate mapping. */
  readonly onSurface: (width: number, height: number) => void
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
  const onSurface = useRef(props.onSurface)
  const onError = useRef(props.onError)
  onSurface.current = props.onSurface
  onError.current = props.onError

  useEffect(() => {
    const target = canvas.current
    /* v8 ignore next -- React assigns the host ref before running this effect. */
    if (target === null) return
    const playback = playPhoneH264Stream({
      url: props.url,
      canvas: target,
      onSurface: (width, height) => { onSurface.current(width, height) },
      onError: (error) => { onError.current(error) },
    })
    return () => { void playback.close() }
  }, [props.url])

  return <canvas ref={canvas} role="img" aria-label={props.label} className={props.className} />
}
