/** Draft-only text annotation vocabulary and ordinary-message compiler. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Browser-runtime identity of one unsent text annotation. */
export type TextAnnotationId = Branded<'TextAnnotationId'>

/**
 * Brand a machine-minted annotation id.
 * @param id - Raw browser-runtime id.
 * @returns The same string with its annotation brand.
 */
export function TextAnnotationId(id: string): TextAnnotationId {
  return id as TextAnnotationId
}

/** Resilient reference to renderer-owned source text from one completed assistant message. */
export interface TextAnchor {
  readonly sourceId: string
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
}

/** One unsent text annotation. */
export interface TextAnnotation {
  readonly id: TextAnnotationId
  readonly kind: 'text'
  readonly anchor: TextAnchor
  readonly note: string
}

/** One unsent pin on a Composer-staged static image. */
export interface ImagePinAnnotation {
  readonly id: TextAnnotationId
  readonly kind: 'image-pin'
  readonly imageId: string
  readonly source: 'composer' | 'history'
  readonly imageName: string
  readonly x: number
  readonly y: number
  readonly note: string
}

/** One unsent draft item in shared creation order. */
export type DraftAnnotation = TextAnnotation | ImagePinAnnotation

/**
 * JSON-persisted whole value of one Session's Annotation Draft. `annotations`
 * keeps creation order and identities; `nextSeq` continues the owner's id
 * sequence so a restored draft never reuses a live identity.
 */
export interface PersistedAnnotationDraft {
  readonly annotations: readonly DraftAnnotation[]
  readonly nextSeq: number
}

/** Locale-owned prose fragments used by the deterministic compiler. */
export interface AnnotationCompilerLabels {
  /** @returns A localized heading for the one-based annotation index. */
  heading: (index: number) => string
  /** @returns A localized exact-quotation paragraph. */
  quote: (value: string) => string
  /** @returns A localized non-empty note paragraph. */
  note: (value: string) => string
  /** @returns A localized image-identity and percentage-coordinate paragraph. */
  image: (name: string, x: number, y: number) => string
  /** Localized overflow notice when advertised capacity is known to be exceeded. */
  overflow: string
}

const CONTEXT_LENGTH = 48

/**
 * Capture a quotation and nearby source text without retaining renderer nodes.
 * @param sourceId - Stable assistant-message identity.
 * @param source - Renderer-owned source-text projection of that message block.
 * @param quote - Exact selected quotation.
 * @param start - Quotation start in `source`.
 * @returns The durable-in-draft text anchor.
 */
export function createTextAnchor(sourceId: string, source: string, quote: string, start: number): TextAnchor {
  if (quote === '' || start < 0 || source.slice(start, start + quote.length) !== quote) {
    throw new Error('text annotation selection does not match its source')
  }
  return {
    sourceId,
    quote,
    prefix: source.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: source.slice(start + quote.length, start + quote.length + CONTEXT_LENGTH),
  }
}

/**
 * Compile unsent annotations into the ordinary user-message text.
 * @param question - Composer question, kept first when present.
 * @param annotations - Annotation creation order.
 * @param labels - Locale-owned readable prose fragments.
 * @returns Plain localized prose with no annotation protocol.
 */
export function compileAnnotationSubmission(
  question: string,
  annotations: readonly DraftAnnotation[],
  labels: AnnotationCompilerLabels,
): string {
  const paragraphs = annotations.map((annotation, index) => {
    const body = annotation.kind === 'text'
      ? labels.quote(annotation.anchor.quote)
      : labels.image(annotation.imageName, annotation.x, annotation.y)
    return [
      labels.heading(index + 1),
      body,
      ...(annotation.note === '' ? [] : [labels.note(annotation.note)]),
    ].join('\n')
  })
  const prompt = question.trim()
  return [...(prompt === '' ? [] : [prompt]), ...paragraphs].join('\n\n')
}

/**
 * Convert a click on the displayed raster into stored percentage coordinates.
 * @param clientX - Pointer X in viewport coordinates.
 * @param clientY - Pointer Y in viewport coordinates.
 * @param rect - Displayed image box.
 * @returns Percentages in `[0, 100]` against the displayed, EXIF-oriented raster.
 */
export function pinPercentFromClientPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  const x = ((clientX - rect.left) / rect.width) * 100
  const y = ((clientY - rect.top) / rect.height) * 100
  return {
    x: Math.min(100, Math.max(0, x)),
    y: Math.min(100, Math.max(0, y)),
  }
}

/**
 * Detect an animated GIF from its bytes. Static GIF and non-GIF files return false.
 * @param bytes - File bytes.
 * @returns whether more than one image descriptor is present.
 */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false
  const header = String.fromCharCode(...bytes.subarray(0, 6))
  if (header !== 'GIF87a' && header !== 'GIF89a') return false
  let frames = 0
  for (let i = 6; i < bytes.length; i += 1) {
    if (bytes[i] === 0x2c) frames += 1
    if (frames > 1) return true
  }
  return false
}

/**
 * Preflight an assembled annotation request against advertised model capacity.
 * Uses a 4-characters-per-token estimate; unknown capacity is not this function.
 * @param assembledChars - Compiled question plus annotation prose length.
 * @param usedTokens - Current projected occupancy.
 * @param contextWindow - Advertised model context capacity.
 * @returns whether the assembled request is known to overflow.
 */
export function assembledRequestOverflows(
  assembledChars: number,
  usedTokens: number,
  contextWindow: number,
): boolean {
  return usedTokens + Math.ceil(assembledChars / 4) > contextWindow
}
