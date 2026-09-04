/**
 * One-shot runner for the external mobilecli `screenshot` command. The
 * runner never shells out to adb; it writes a still PNG through the
 * upstream CLI and reads that file after the child exits.
 * @module @deepseek-ai/dsh-phone-runtime/screenshot-process
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deadline, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { realDeviceIssueError } from './classify.ts'
import { phoneFailureWithCleanup, PhoneDevicesError } from './errors.ts'
import { isPng } from './png.ts'
import { normalizeOperationError } from './rpc.ts'
import { MobilecliProcessTree, retainTail } from './server-process.ts'

/** Maximum PNG file bytes admitted from one screenshot command. */
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024

/** Inputs for one screenshot command run. */
export interface MobilecliScreenshotRunOptions {
  /** Absolute mobilecli executable path resolved at Service construction. */
  readonly executablePath: string
  /** Branded Android serial or iOS UDID whose screen to capture. */
  readonly deviceId: string
  /** Caller's optional cancellation signal, fused with the run ceiling. */
  readonly signal: AbortSignal | undefined
  /** Validated ceiling bounding the child run, in milliseconds. */
  readonly timeoutMs: number
  /** Non-sensitive runtime environment selected with the executable generation. */
  readonly environment?: Readonly<Record<string, string>>
}

/**
 * Run `mobilecli screenshot --format png` to a temp file and return the PNG
 * bytes. A non-zero exit is classified onto a structured real-device arm when
 * the output names one, and `PHONE_UPSTREAM` otherwise.
 * @param options - Executable path, device id, cancellation, and ceiling.
 * @returns complete PNG file bytes.
 * @throws {@link PhoneDevicesError} with `PHONE_ABORTED` when the caller's signal
 *   won, `PHONE_TIMEOUT` when the ceiling elapsed, `PHONE_REAL_DEVICE_ISSUE`
 *   carrying the matched arm, `PHONE_UPSTREAM` for other non-zero exits,
 *   `PHONE_PROTOCOL` for a non-PNG answer, and `PHONE_UNAVAILABLE` when the
 *   executable cannot start.
 */
export async function runMobilecliScreenshot(options: MobilecliScreenshotRunOptions): Promise<Uint8Array> {
  if (options.signal?.aborted === true) {
    throw new PhoneDevicesError('PHONE_ABORTED', 'cancelled before the screenshot command was sent')
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phone-shot-'))
  const outputPath = join(dir, 'shot.png')
  const budget = deadline(options.signal, options.timeoutMs, 'screenshot')
  const tree = new MobilecliProcessTree({
    executablePath: options.executablePath,
    args: ['screenshot', '--device', options.deviceId, '--format', 'png', '--output', outputPath],
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
  })
  const child = tree.process
  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = retainTail(stderrTail, chunk.toString('utf8'))
  })
  const stopped = Promise.withResolvers<void>()
  const onAbort = (): void => {
    void tree.stop().then(stopped.resolve, stopped.reject)
  }
  budget.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const exit = await Promise.race([
      tree.exit,
      stopped.promise.then(() => tree.exit),
    ])
    if (budget.signal.aborted) {
      await tree.stop()
      throw screenshotHalt(budget.signal.reason, options.timeoutMs)
    }
    if (tree.error !== undefined) {
      throw new PhoneDevicesError(
        'PHONE_UNAVAILABLE',
        `the mobilecli screenshot command could not start: ${tree.error.message}`,
        { cause: tree.error },
      )
    }
    if (exit.code !== 0) {
      const issueError = realDeviceIssueError(stderrTail)
      if (issueError !== undefined) throw issueError
      if (/no device/iu.test(stderrTail)) {
        throw new PhoneDevicesError(
          'PHONE_DEVICE_NOT_FOUND',
          `no device answers that id upstream: ${stderrTail.trim()}`,
        )
      }
      throw new PhoneDevicesError(
        'PHONE_UPSTREAM',
        `mobilecli screenshot failed with exit code ${String(exit.code)}\n${stderrTail.trim() || '(no output)'}`,
      )
    }
    let bytes: Buffer
    try {
      bytes = await readFile(outputPath)
    } catch (error) {
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        'mobilecli screenshot answered no PNG file',
        { cause: error },
      )
    }
    /* v8 ignore next -- the 8 MiB ceiling is a safety bound, not a fixture size. */
    if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `mobilecli screenshot exceeded ${String(SCREENSHOT_MAX_BYTES)} bytes`,
      )
    }
    if (!isPng(bytes)) {
      throw new PhoneDevicesError('PHONE_PROTOCOL', 'mobilecli screenshot answered no PNG file')
    }
    return Uint8Array.from(bytes)
  } catch (error) {
    if (budget.signal.aborted) {
      const halt = screenshotHalt(budget.signal.reason, options.timeoutMs)
      if (error instanceof PhoneDevicesError && error.code === halt.code) throw error
      throw phoneFailureWithCleanup(halt, error, 'mobilecli screenshot process-tree cleanup failed')
    }
    /* v8 ignore next -- non-abort tree.exit cannot reject; retained for the public normalization defense. */
    if (error instanceof PhoneDevicesError) throw error
    /* v8 ignore start -- both raced promises settle only from tree.exit or abort-driven
       tree.stop; the latter is handled above and tree.exit never rejects. */
    throw new PhoneDevicesError(
      'PHONE_UPSTREAM',
      `mobilecli screenshot process-tree teardown failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
    /* v8 ignore stop */
  } finally {
    budget.signal.removeEventListener('abort', onAbort)
    budget[Symbol.dispose]()
    /* v8 ignore next -- leftover temp files must not replace a classified screenshot result. */
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Translate the abort winner of a halted screenshot run onto the public vocabulary.
 * @param reason - Fused budget signal's abort reason.
 * @param timeoutMs - Ceiling the run was bounded by.
 * @returns the normalized public failure.
 */
function screenshotHalt(reason: unknown, timeoutMs: number): PhoneDevicesError {
  if (reason instanceof TimeoutReason) {
    return new PhoneDevicesError(
      'PHONE_TIMEOUT',
      `mobilecli screenshot exceeded its ${String(timeoutMs)}ms ceiling`,
      { cause: reason },
    )
  }
  return normalizeOperationError(reason)
}
