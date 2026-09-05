import type { ServerResponse } from 'node:http'
import { HttpError, writeHttpError, writeJson } from '@deepseek-ai/dsh-host-webserver'
import { PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { CaptureSink } from './capture-relays.ts'
import { MJPEG_NORMALIZED_BOUNDARY } from './multipart-normalize.ts'

/** ServerResponse adapter for one capture relay. */
export class ServerResponseCaptureSink implements CaptureSink {
  constructor(private readonly response: ServerResponse, private readonly multipart: boolean) {}
  expose(contentType: string): void {
    this.response.writeHead(200, {
      'content-type': this.multipart ? `multipart/x-mixed-replace; boundary=${MJPEG_NORMALIZED_BOUNDARY}` : contentType,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    })
  }
  async write(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    if (this.response.write(Buffer.from(chunk))) return
    await waitForResponseDrain(this.response, signal)
  }
  end(): void { this.response.end() }
  fail(error: unknown): void {
    if (this.response.headersSent) { this.response.destroy(error instanceof Error ? error : undefined); return }
    writeCaptureFailure(this.response, error)
  }
  abort(): void { this.response.destroy() }
}

/** Wait for response backpressure with exact listener cleanup.
 * @param response - HTTP response whose drain lifecycle is observed.
 * @param signal - Relay cancellation signal.
 * @returns completion when the response drains.
 */
export async function waitForResponseDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drained)
      response.off('close', closed)
      response.off('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = (): void => { cleanup(); resolve() }
    const closed = (): void => { cleanup(); reject(new Error('capture response closed before drain')) }
    const failed = (error: Error): void => { cleanup(); reject(error) }
    const aborted = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('capture response aborted')) }
    response.once('drain', drained)
    response.once('close', closed)
    response.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

function writeCaptureFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) { writeHttpError(response, error); return }
  if (error instanceof PhoneDevicesError && error.code === 'PHONE_DEVICE_NOT_FOUND') {
    writeHttpError(response, new HttpError(404, 'not-found', error.message)); return
  }
  if (error instanceof PhoneDevicesError) {
    writeJson(response, error.code === 'PHONE_AGENT_PROFILE_REQUIRED' ? 409 : 502, {
      error: { code: error.code, message: error.message, ...(error.issue === undefined ? {} : { issue: error.issue }) },
    }); return
  }
  writeHttpError(response, new HttpError(502, 'upstream', error instanceof Error ? error.message : String(error)))
}
