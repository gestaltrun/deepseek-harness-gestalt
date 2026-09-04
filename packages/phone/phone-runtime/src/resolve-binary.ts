/**
 * Loud resolution of the external `mobilecli` executable. Discovery searches
 * `executablePath`, then `PATH`, then npm-global / npx-cache / well-known
 * prefixes so an Electron GUI process with a minimal PATH still finds a
 * global install. Nothing here executes or vendors mobilecli, so the
 * FSL-1.1-Apache-2.0 external-dependency edge stays intact.
 * @module @deepseek-ai/dsh-phone-runtime/resolve-binary
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/** Inputs for {@link resolveMobilecliExecutable}. */
export interface ResolveMobilecliOptions {
  /** Configured absolute or cwd-relative override, or `undefined` to search `PATH` then npm locations. */
  readonly executablePath?: string
  /** Environment providing `PATH`, `HOME` / `USERPROFILE`, optional `npm_config_prefix`, and on Windows `PATHEXT`. */
  readonly env: NodeJS.ProcessEnv
  /** Windows behavior switch (executable-bit checks and extension probing); defaults to `process.platform === 'win32'`. */
  readonly isWindows?: boolean
  /** Home directory for the npm-global and npx-cache candidates; defaults to `env.HOME` then `env.USERPROFILE`. */
  readonly home?: string
}

const INSTALL_LINES = [
  'Install it first, then retry:',
  '  npm install -g mobilecli@latest',
  '(or run it once via `npx mobilecli@latest`). No Homebrew formula exists upstream;',
  'prerequisites: Android SDK with adb in PATH for Android devices, Xcode Command Line',
  'Tools for iOS simulators.',
  '',
  'Set the phoneDevices config field `executablePath` to override discovery.',
] as const

/**
 * Compose the fail-loud installation guidance carried by unresolved-binary failures.
 * @param searched - Directory list that was searched, rendered into the message.
 * @returns the multi-line guidance text including the npm install line.
 */
export function mobilecliInstallGuidance(searched: readonly string[]): string {
  const listed = searched.length > 0 ? searched.map(dir => `  ${dir}`).join('\n') : '  (no candidate directories)'
  return [
    'phone-runtime: cannot resolve the mobilecli executable. Searched:',
    listed,
    '',
    ...INSTALL_LINES,
  ].join('\n')
}

/**
 * Resolve the mobilecli executable before any spawn happens. A missing binary
 * throws install guidance; the Service catches that and stays composed.
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
  const home = options.home ?? options.env.HOME ?? options.env.USERPROFILE ?? ''
  const searched = searchPaths(options.env, home, isWindows)
  for (const directory of searched) {
    for (const candidate of candidateNames(isWindows, options.env)) {
      const full = resolve(directory, candidate)
      if (isExecutableFile(full, isWindows)) return full
    }
  }
  throw new Error(mobilecliInstallGuidance(searched))
}

/** Directories Electron GUI processes keep when they replace the user PATH. */
const ELECTRON_MINIMAL_PATH = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])

function searchPaths(env: NodeJS.ProcessEnv, home: string, isWindows: boolean): string[] {
  const seen = new Set<string>()
  const directories: string[] = []
  const add = (directory: string): void => {
    if (directory.length === 0 || seen.has(directory)) return
    seen.add(directory)
    directories.push(directory)
  }
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(directory => directory.length > 0)
  for (const directory of pathDirs) add(directory)
  // Electron GUI processes ship a minimal PATH; npm's well-known locations
  // cover the global install and the npx cache the CLI docs point at.
  if (home.length > 0) {
    add(join(home, '.npm-global', 'bin'))
    add(join(home, '.local', 'bin'))
    if (isWindows) add(join(home, 'AppData', 'Roaming', 'npm'))
    for (const directory of npxBinDirectories(join(home, '.npm', '_npx'))) add(directory)
  }
  const prefix = env.npm_config_prefix
  if (prefix !== undefined && prefix.length > 0) {
    add(isWindows ? prefix : join(prefix, 'bin'))
  }
  if (!isWindows && isElectronMinimalPath(pathDirs)) {
    add('/opt/homebrew/bin')
    add('/usr/local/bin')
  }
  return directories
}

function isElectronMinimalPath(pathDirs: readonly string[]): boolean {
  return pathDirs.length > 0 && pathDirs.every(directory => ELECTRON_MINIMAL_PATH.has(directory))
}

function npxBinDirectories(npxRoot: string): string[] {
  try {
    return readdirSync(npxRoot).map(entry => join(npxRoot, entry, 'node_modules', '.bin'))
  } catch {
    // Missing or unreadable npx cache; PATH and npm-global candidates still apply.
    return []
  }
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
  throw new Error([
    `phone-runtime: ${subject} is not an executable file; fix the path or drop the field to search PATH.`,
    '',
    ...INSTALL_LINES,
  ].join('\n'))
}
