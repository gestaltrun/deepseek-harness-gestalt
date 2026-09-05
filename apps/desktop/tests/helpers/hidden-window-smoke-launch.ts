import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..', '..')

/** Built Electron ESM entry. Electron loads this file, not the TypeScript source. */
export const HIDDEN_WINDOW_SMOKE_ENTRY = join(desktopRoot, 'out', 'hidden-window-smoke.mjs')
/** TypeScript source bundled by `HIDDEN_WINDOW_SMOKE_BUNDLE`. Not an Electron argv entry. */
export const HIDDEN_WINDOW_SMOKE_SOURCE = join(desktopRoot, 'scripts', 'hidden-window-smoke.ts')
/** esbuild helper that writes `HIDDEN_WINDOW_SMOKE_ENTRY`. */
export const HIDDEN_WINDOW_SMOKE_BUNDLE = join(desktopRoot, 'scripts', 'build-hidden-window-smoke.mjs')

/**
 * @returns The bundled smoke entry after verifying it exists.
 * @throws If `scripts/build-hidden-window-smoke.mjs` has not produced the ESM main.
 */
export function requireHiddenWindowSmokeEntry(): string {
  if (!existsSync(HIDDEN_WINDOW_SMOKE_ENTRY)) {
    throw new Error(
      `hidden-window smoke requires bundled ${HIDDEN_WINDOW_SMOKE_ENTRY}; run node ${HIDDEN_WINDOW_SMOKE_BUNDLE}`,
    )
  }
  return HIDDEN_WINDOW_SMOKE_ENTRY
}

/**
 * Spawn the bundled smoke. Electron argv is the built `.mjs` only.
 *
 * @param options.electronBin Electron binary path.
 * @param options.resultPath Path for `--dsh-hidden-window-result=`.
 * @param options.userData Isolated `--user-data-dir=`.
 * @param options.env Allowlisted child env from `hiddenWindowSmokeEnvironment`.
 * @returns The exact ChildProcess; `detached` is false.
 * @throws If the bundled ESM main is missing.
 */
export function spawnHiddenWindowSmoke(options: {
  readonly electronBin: string
  readonly resultPath: string
  readonly userData: string
  readonly env: NodeJS.ProcessEnv
}): ChildProcess {
  const entry = requireHiddenWindowSmokeEntry()
  return spawn(options.electronBin, [
    entry,
    `--user-data-dir=${options.userData}`,
    `--dsh-hidden-window-result=${options.resultPath}`,
  ], {
    cwd: desktopRoot,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  })
}
