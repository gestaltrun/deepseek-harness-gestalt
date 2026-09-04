/** Current Android logical display size from `adb dumpsys display`. */

import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { childEnv } from '@deepseek-ai/dsh-subprocess'

/** Logical display pixels reported by SurfaceFlinger, not `device.info.screenSize`. */
export interface AndroidLogicalDisplay {
  /** Logical width in pixels (`logicalFrame` right edge). */
  readonly width: number
  /** Logical height in pixels (`logicalFrame` bottom edge). */
  readonly height: number
}

/** Injectable resolver and dumpsys runner used by listing and capture tests. */
export interface AndroidDisplayInternals {
  readonly platform?: NodeJS.Platform
  readonly isExecutable?: (path: string) => boolean
  readonly exec?: (options: {
    readonly executablePath: string
    readonly args: readonly string[]
    readonly environment: Readonly<Record<string, string>>
  }) => { readonly stdout: string; readonly status: number | null }
}

/** Inputs for one dumpsys display read. */
export interface AndroidLogicalDisplayOptions {
  /** Android serial passed to adb. */
  readonly deviceId: string
  /** Runtime generation environment containing the selected Android SDK PATH. */
  readonly environment: Readonly<Record<string, string>>
}

/**
 * Resolve adb from the selected Android SDK, falling back to its PATH name.
 * @param environment - Runtime generation environment.
 * @param platform - Host platform selecting `adb` vs `adb.exe`.
 * @param isExecutable - Whether a candidate SDK path can be executed.
 * @returns the executable path or PATH basename.
 */
export function resolveAdbExecutable(
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
 * Parse `dumpsys display` for the current logical frame.
 * `device.info.screenSize` stays at the physical portrait size on MI 8 while
 * `mCurrentOrientation=1` and `logicalFrame=Rect(0, 0 - 2248, 1080)`.
 * @param text - Complete `dumpsys display` stdout.
 * @returns logical pixels, or `undefined` when the frame is absent or empty.
 */
export function parseAndroidLogicalDisplay(text: string): AndroidLogicalDisplay | undefined {
  const frame = /logicalFrame=Rect\(\s*\d+\s*,\s*\d+\s*-\s*(\d+)\s*,\s*(\d+)\s*\)/u.exec(text)
  const width = Number(frame?.[1])
  const height = Number(frame?.[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

/**
 * Read the current logical display size through `adb shell dumpsys display`.
 * A missing adb, non-zero exit, or unparseable stdout returns `undefined`;
 * callers must not fall back to sticky `device.info.screenSize`.
 * @param options - Device serial and selected Android environment.
 * @param internals - Injectable platform, executable probe, and dumpsys runner.
 * @returns logical pixels when dumpsys reports a positive `logicalFrame`.
 */
export function readAndroidLogicalDisplay(
  options: AndroidLogicalDisplayOptions,
  internals: AndroidDisplayInternals = {},
): AndroidLogicalDisplay | undefined {
  const platform = internals.platform ?? process.platform
  const executablePath = resolveAdbExecutable(
    options.environment,
    platform,
    internals.isExecutable ?? (path => executableOnHost(path, platform)),
  )
  const args = ['-s', options.deviceId, 'shell', 'dumpsys', 'display'] as const
  let result: { readonly stdout: string; readonly status: number | null }
  try {
    result = internals.exec?.({ executablePath, args, environment: options.environment })
      ?? spawnSync(executablePath, [...args], {
        encoding: 'utf8',
        timeout: 3_000,
        env: childEnv(options.environment),
        windowsHide: true,
      })
  } catch {
    return undefined
  }
  if (result.status !== 0) return undefined
  return parseAndroidLogicalDisplay(result.stdout)
}

/**
 * Whether a candidate SDK adb path is runnable on the selected Host platform.
 * @param path - Absolute or relative executable path.
 * @param platform - Host platform selecting existence or POSIX execute permission.
 * @param access - Filesystem access probe.
 * @param stat - Filesystem metadata probe.
 * @returns true when the path is a file and the platform-appropriate access check succeeds.
 */
export function executableOnHost(
  path: string,
  platform: NodeJS.Platform = process.platform,
  access: typeof accessSync = accessSync,
  stat: typeof statSync = statSync,
): boolean {
  try {
    if (!stat(path).isFile()) return false
    access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}
