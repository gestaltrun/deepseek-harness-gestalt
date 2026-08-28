/**
 * Multipart normalization for the capture proxy. Real mobilecli 1.0.5 streams
 * open under the declared boundary carrying JSON notification parts and then
 * mid-stream switch to an undeclared frame boundary, which a browser that
 * trusts the declared boundary can never parse. The normalizer re-emits every
 * image part under one self-consistent output boundary with exact per-part
 * headers, drops every other part, and streams each frame as soon as its
 * closing delimiter arrives — it never transcodes or reassembles frame bytes
 * and never buffers more than one part.
 * @module @deepseek-ai/dsh-phone-stream/multipart-normalize
 */

/** Output boundary the browser parses; every emitted part uses it. */
export const MJPEG_NORMALIZED_BOUNDARY = 'frame'

/** Longest legal MIME boundary token (RFC 2046 caps the delimiter line at 70). */
const MAX_DELIMITER_LENGTH = 70

/** Ceiling on part headers before a delimiter hit is treated as payload bytes. */
const MAX_HEADER_WINDOW = 4_096

/**
 * The scanner alternates between the two phases every multipart body mandates:
 * a delimiter line introduces part headers, the blank line introduces the
 * payload, and the next delimiter line terminates it.
 */
type ScanPhase = 'delimiter' | 'payload'

interface ScanState {
  buffer: Buffer
  cursor: number
  upstreamDone: boolean
  phase: ScanPhase
}

function isDelimiterCandidate(line: string): boolean {
  if (!line.startsWith('--') || line.length > MAX_DELIMITER_LENGTH + 2) return false
  const token = line.slice(2)
  return token.length > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token)
}

function parseHeaders(headerBlock: Buffer): ReadonlyMap<string, string> {
  const headers = new Map<string, string>()
  for (const line of headerBlock.toString('utf8').split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  return headers
}

/**
 * Rewrite a multipart capture body into one boundary of pure image frames:
 * non-image parts (JSON notifications) are dropped, image payloads are kept
 * byte-identical, and every emitted part carries an exact Content-Length under
 * the single normalized boundary. The stream closes with the boundary's final
 * `--` marker once at least one frame was emitted.
 * @param body - Upstream capture body stream.
 * @param boundary - Output boundary; defaults to the proxy-standard `frame`.
 * @returns the normalized stream; completes when the upstream ends, dropping a
 *   trailing incomplete part.
 */
export function normalizeMultipartImageStream(
  body: ReadableStream<Uint8Array>,
  boundary: string = MJPEG_NORMALIZED_BOUNDARY,
): ReadableStream<Uint8Array> {
  const state: ScanState = { buffer: Buffer.alloc(0), cursor: 0, upstreamDone: false, phase: 'delimiter' }
  const reader = body.getReader()
  const delimiterLine = Buffer.from(`--${boundary}\r\n`)
  const finalMarker = Buffer.from(`--${boundary}--\r\n`)
  let emitted = false

  async function pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    // A cancelled stream never pulls again, so finish() here always runs on a
    // live controller.
    const finish = (): void => {
      if (emitted) controller.enqueue(finalMarker)
      controller.close()
    }
    for (;;) {
      if (state.phase === 'delimiter') {
        const lineEnd = state.buffer.indexOf('\r\n', state.cursor)
        if (lineEnd < 0) {
          if (state.upstreamDone) {
            finish()
            return
          }
        } else {
          const line = state.buffer.subarray(state.cursor, lineEnd).toString('latin1')
          if (!isDelimiterCandidate(line)) {
            // Preamble or noise between families; the next line may delimit.
            state.cursor = lineEnd + 2
            continue
          }
          // One boundary family closed (`--` suffix) or a new part opened;
          // both leave the scanner waiting for the next delimiter line.
          state.phase = line.endsWith('--') ? 'delimiter' : 'payload'
          state.cursor = lineEnd + 2
          continue
        }
      } else {
        const headerEnd = state.buffer.indexOf('\r\n\r\n', state.cursor)
        if (headerEnd < 0 || headerEnd - state.cursor > MAX_HEADER_WINDOW) {
          // A delimiter candidate whose headers never terminate was a payload
          // false positive; resync at the next candidate line.
          const next = state.buffer.indexOf('\r\n--', state.cursor + 2)
          if (next < 0) {
            if (state.upstreamDone) {
              finish()
              return
            }
          } else {
            state.cursor = next + 2
            state.phase = 'delimiter'
          }
        } else {
          const headers = parseHeaders(state.buffer.subarray(state.cursor, headerEnd))
          const payloadStart = headerEnd + 4
          const close = state.buffer.indexOf('\r\n--', payloadStart)
          if (close < 0) {
            if (state.upstreamDone) {
              // The trailing part never closed; drop it and finish.
              finish()
              return
            }
          } else {
            const contentType = headers.get('content-type') ?? ''
            state.cursor = close + 2
            state.phase = 'delimiter'
            if (contentType.toLowerCase().startsWith('image/')) {
              controller.enqueue(Buffer.concat([
                delimiterLine,
                Buffer.from(`Content-Type: ${contentType}\r\nContent-Length: ${String(close - payloadStart)}\r\n\r\n`),
                state.buffer.subarray(payloadStart, close),
                Buffer.from('\r\n'),
              ]))
              emitted = true
              state.buffer = state.buffer.subarray(state.cursor)
              state.cursor = 0
              return
            }
            // Dropped part: keep scanning the already-buffered bytes.
            continue
          }
        }
      }
      // Every need-more branch above finishes by itself once the upstream is
      // done, so reaching this line means more bytes may still arrive.
      const next = await reader.read()
      if (next.done) {
        state.upstreamDone = true
        continue
      }
      state.buffer = Buffer.concat([state.buffer, Buffer.from(next.value)])
    }
  }

  return new ReadableStream<Uint8Array>(
    {
      pull,
      cancel(): void {
        void reader.cancel()
      },
    },
    // One part is held at most; the frame itself is the natural unit.
    { highWaterMark: 1 },
  )
}
