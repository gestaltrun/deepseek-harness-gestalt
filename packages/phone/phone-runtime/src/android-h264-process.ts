/** Android system-screenrecord H264 capture owned through bounded process-tree teardown. */

import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { posix, win32 } from 'node:path'
import { PhoneDevicesError } from './errors.ts'
import { MobilecliProcessTree, type ServerExit } from './server-process.ts'

interface CaptureProcessTree {
  readonly process: ChildProcess
  readonly exit: Promise<ServerExit>
  readonly error: NodeJS.ErrnoException | undefined
  readonly lastStderr: string
  stop(): Promise<void>
}

/** Injectable launcher used by lifecycle tests. */
export interface AndroidH264ProcessInternals {
  readonly platform?: NodeJS.Platform
  readonly isExecutable?: (path: string) => boolean
  readonly launch?: (options: {
    readonly executablePath: string
    readonly args: readonly string[]
    readonly environment: Readonly<Record<string, string>>
  }) => CaptureProcessTree
}

/** Inputs for one Android system H264 capture. */
export interface AndroidH264CaptureOptions {
  /** Android serial passed to adb. */
  readonly deviceId: string
  /** Runtime generation environment containing the selected Android SDK PATH. */
  readonly environment: Readonly<Record<string, string>>
  /** Runtime-generation or caller cancellation. */
  readonly signal: AbortSignal
}

/** Resolve adb from the selected Android SDK, falling back to its PATH name. */
function adbExecutable(
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  isExecutable: (path: string) => boolean,
): string {
  const sdkRoot = environment.ANDROID_SDK_ROOT?.trim() || environment.ANDROID_HOME?.trim()
  const basename = platform === 'win32' ? 'adb.exe' : 'adb'
  if (sdkRoot !== undefined && sdkRoot.length > 0) {
    const selected = (platform === 'win32' ? win32 : posix).join(sdkRoot, 'platform-tools', basename)
    if (isExecutable(selected)) return selected
  }
  return basename
}

/**
 * Open Android's system `screenrecord` as a raw Annex-B H264 stream. This is
 * used only after mobilecli's Android AVC stream fails syntax recognition;
 * control and device discovery remain on the active mobilecli generation.
 * @param options - Device, selected Android environment, and lifetime signal.
 * @param internals - Injectable platform and launcher for lifecycle tests.
 * @returns raw H264 body whose cancellation stops the complete adb process tree.
 */
export function openAndroidSystemH264(
  options: AndroidH264CaptureOptions,
  internals: AndroidH264ProcessInternals = {},
): ReadableStream<Uint8Array> {
  if (options.signal.aborted) throw aborted(options.signal.reason)
  const platform = internals.platform ?? process.platform
  const executablePath = adbExecutable(
    options.environment,
    platform,
    internals.isExecutable ?? executableOnHost,
  )
  const args = ['-s', options.deviceId, 'exec-out', 'screenrecord', '--output-format=h264', '-'] as const
  const tree = internals.launch?.({ executablePath, args, environment: options.environment })
    ?? new MobilecliProcessTree({
      executablePath,
      args,
      environment: options.environment,
      captureStdout: true,
    })
  const stdout = tree.process.stdout
  if (stdout === null) {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await tree.stop()
          controller.error(new PhoneDevicesError('PHONE_UNAVAILABLE', 'adb screenrecord exposed no stdout stream'))
        } catch (error) {
          controller.error(captureFailure('exposed no stdout and cleanup failed', tree, error))
        }
      },
    })
  }

  let settled = false
  let removeListeners: () => void
  stdout.pause()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const stopForAbort = (): void => {
        if (settled) return
        settled = true
        removeListeners()
        void tree.stop().then(
          () => { controller.error(aborted(options.signal.reason)) },
          (error: unknown) => { controller.error(captureFailure('abort cleanup failed', tree, error)) },
        )
      }
      const onData = (chunk: Buffer): void => {
        if (settled) return
        controller.enqueue(Uint8Array.from(chunk))
        if ((controller.desiredSize as number) <= 0) stdout.pause()
      }
      stdout.on('data', onData)
      options.signal.addEventListener('abort', stopForAbort, { once: true })
      removeListeners = () => {
        stdout.off('data', onData)
        options.signal.removeEventListener('abort', stopForAbort)
      }
      void tree.exit.then((exit) => {
        if (settled) return
        settled = true
        removeListeners()
        if (tree.error !== undefined) {
          controller.error(new PhoneDevicesError(
            'PHONE_UNAVAILABLE',
            `adb screenrecord could not start: ${tree.error.message}`,
            { cause: tree.error },
          ))
          return
        }
        if (exit.code === 0) controller.close()
        else controller.error(captureFailure(`exited with code ${String(exit.code)}`, tree))
      })
    },
    pull() {
      if (!settled) stdout.resume()
    },
    async cancel() {
      settled = true
      removeListeners()
      await tree.stop()
    },
  })
}

function executableOnHost(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function aborted(reason: unknown): PhoneDevicesError {
  return new PhoneDevicesError(
    'PHONE_ABORTED',
    'Android system H264 capture was cancelled',
    reason instanceof Error ? { cause: reason } : undefined,
  )
}

function captureFailure(label: string, tree: CaptureProcessTree, cause?: unknown): PhoneDevicesError {
  const stderr = tree.lastStderr.trim()
  return new PhoneDevicesError(
    'PHONE_UPSTREAM',
    `adb screenrecord ${label}${stderr.length === 0 ? '' : `; stderr tail follows\n${stderr}`}`,
    cause === undefined ? undefined : { cause },
  )
}
