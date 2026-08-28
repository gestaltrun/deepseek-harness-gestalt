/**
 * Loud resolution of the external `mobilecli` executable. Discovery searches
 * `PATH` the way Node's `spawn` would; nothing here executes or vendors
 * mobilecli, so the FSL-1.1-Apache-2.0 external-dependency edge stays intact.
 * @module @deepseek-ai/dsh-phone-runtime/resolve-binary
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

/** Inputs for {@link resolveMobilecliExecutable}. */
export interface ResolveMobilecliOptions {
  /** Configured absolute or cwd-relative override, or `undefined` to search `PATH`. */
  readonly executablePath?: string
  /** Environment providing `PATH` and, on Windows, `PATHEXT`. */
  readonly env: NodeJS.ProcessEnv
  /** Windows behavior switch (executable-bit checks and extension probing); defaults to `process.platform === 'win32'`. */
  readonly isWindows?: boolean
}

/**
 * Compose the fail-loud installation guidance carried by activation failures.
 * @param searched - Directory list that was searched, rendered into the message.
 * @returns the multi-line guidance text including the npm install line.
 */
export function mobilecliInstallGuidance(searched: readonly string[]): string {
  const listed = searched.length > 0 ? searched.map(dir => `  ${dir}`).join('\n') : '  (PATH is empty)'
  return [
    'phone-runtime: cannot resolve the mobilecli executable. Searched:',
    listed,
    '',
    'Install it first, then retry composition:',
    '  npm install -g mobilecli@latest',
    '(or run it once via `npx mobilecli@latest`). No Homebrew formula exists upstream;',
    'prerequisites: Android SDK with adb in PATH for Android devices, Xcode Command Line',
    'Tools for iOS simulators.',
    '',
    'Set the phoneDevices config field `executablePath` to override discovery.',
  ].join('\n')
}

/**
 * Resolve the mobilecli executable before any spawn happens, so a missing
 * binary fails composition loudly instead of degrading at first use.
 * @param options - Override path, environment, and platform switch.
 * @returns the absolute executable path accepted by `child_process.spawn`.
 * @throws an `Error` carrying {@link mobilecliInstallGuidance} when discovery fails,
 *   or naming the configured override when it does not name an executable file.
 */
export function resolveMobilecliExecutable(options: ResolveMobilecliOptions): string {
  const isWindows = options.isWindows ?? process.platform === 'win32'
  if (options.executablePath !== undefined && options.executablePath.length > 0) {
    const explicit = isAbsolute(options.executablePath)
      ? options.executablePath
      : resolve(options.executablePath)
    assertExecutableFile(explicit, isWindows, `the configured phoneDevices \`executablePath\` ${JSON.stringify(explicit)}`)
    return explicit
  }
  const searched = searchPaths(options.env)
  for (const directory of searched) {
    for (const candidate of candidateNames(isWindows, options.env)) {
      const full = resolve(directory, candidate)
      if (isExecutableFile(full, isWindows)) return full
    }
  }
  throw new Error(mobilecliInstallGuidance(searched))
}

function searchPaths(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter(directory => directory.length > 0)
}

function candidateNames(isWindows: boolean, env: NodeJS.ProcessEnv): readonly string[] {
  if (!isWindows) return ['mobilecli']
  // Windows npm shims are .cmd/.bat next to a .exe; PATHEXT order decides priority.
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext.length > 0)
  return [...extensions.map(ext => `mobilecli${ext.toLowerCase()}`), 'mobilecli']
}

function isExecutableFile(path: string, isWindows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (isWindows) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function assertExecutableFile(path: string, isWindows: boolean, subject: string): void {
  if (isExecutableFile(path, isWindows)) return
  throw new Error(`phone-runtime: ${subject} is not an executable file; fix the path or drop the field to search PATH.`)
}
