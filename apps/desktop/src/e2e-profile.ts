/** Explicit per-process environment profile for the source-only Electron acceptance lane. */

import { readFileSync } from 'node:fs'

const PROFILE_PREFIX = '--dsh-e2e-profile='
const ALLOWED_ENVIRONMENT = new Set([
  'DSH_HOME',
  'DSH_DESKTOP_SMOKE_FILE',
  'DSH_MEMBER_QUESTION_KEYLESS_ORIGIN',
  'DSH_MEMBER_QUESTION_ACCOUNT_ID',
  'DSH_MEMBER_QUESTION_INSTALLATION_ID',
  'DSH_MEMBER_QUESTION_KEY',
  'DSH_MEMBER_QUESTION_HEARTBEAT_MS',
  'DSH_MEMBER_QUESTION_POLL_MS',
  'DSH_MEMBER_QUESTION_TTL_MS',
  'DSH_PROJECT_MEMBERS_PROJECT_ID',
  'DSH_PROJECT_MEMBERS_PROJECT_NAME',
  'DSH_PROJECT_MEMBERS_REMOTE_ACCOUNT_ID',
  'DSH_PROJECT_MEMBERS_ASKER_NAME',
  'DSH_PROJECT_MEMBERS_ASKER_ROLE',
  'DSH_PROJECT_MEMBERS_WORKSPACE',
])

/** Native BrowserWindow presentation selected by a source-only E2E profile. */
export type DesktopWindowPresentation = 'visible' | 'hidden'

/** Result of applying one runner-authored source-only profile. */
export interface AppliedDesktopE2EProfile {
  readonly path: string
  readonly windowPresentation: DesktopWindowPresentation
}

/**
 * Apply one runner-authored profile before the Desktop boots its owners.
 *
 * Validates the complete JSON document before mutating any environment field.
 * Omitted profiles leave product presentation visible. Packaged and unarmed
 * runs reject a profile argument. `CI` is not a presentation selector.
 *
 * @param options Packaged flag, process argv, and the environment object that may receive allowlisted fields.
 * @returns Frozen applied path and presentation, or `undefined` when no profile argument is present.
 */
export function applyDesktopE2EProfile(options: {
  readonly packaged: boolean
  readonly argv: readonly string[]
  readonly environment: NodeJS.ProcessEnv
}): AppliedDesktopE2EProfile | undefined {
  const argument = options.argv.find(value => value.startsWith(PROFILE_PREFIX))
  if (argument === undefined) return undefined
  if (options.packaged || options.environment.DSH_DESKTOP_E2E !== '1') {
    throw new Error('Desktop E2E profiles are accepted only by an explicit source acceptance run')
  }
  const path = argument.slice(PROFILE_PREFIX.length)
  if (path.length === 0) throw new TypeError('Desktop E2E profile path must be non-empty')
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop E2E profile must be an object')
  }
  const entries = Object.entries(value)
  for (const [name, field] of entries) {
    if (name === 'windowPresentation') {
      if (field !== 'visible' && field !== 'hidden') {
        throw new TypeError('Desktop E2E profile field windowPresentation must be visible or hidden')
      }
      continue
    }
    if (!ALLOWED_ENVIRONMENT.has(name)) throw new TypeError(`Desktop E2E profile contains unknown field ${name}`)
    if (typeof field !== 'string' || field.length === 0) {
      throw new TypeError(`Desktop E2E profile field ${name} must be a non-empty string`)
    }
  }
  const envUpdates: Record<string, string> = {}
  let windowPresentation: DesktopWindowPresentation = 'visible'
  for (const [name, field] of entries) {
    if (name === 'windowPresentation') {
      windowPresentation = field === 'hidden' ? 'hidden' : 'visible'
      continue
    }
    if (typeof field !== 'string') throw new TypeError(`Desktop E2E profile field ${name} must be a non-empty string`)
    envUpdates[name] = field
  }
  Object.assign(options.environment, envUpdates)
  const applied: AppliedDesktopE2EProfile = Object.freeze({ path, windowPresentation })
  return applied
}

/** Injected BrowserWindow operations used by activate/second-instance presentation fencing. */
export interface DesktopWindowActivateTarget {
  readonly isDestroyed: () => boolean
  readonly isMinimized: () => boolean
  readonly restore: () => void
  readonly focus: () => void
}

/**
 * @param presentation Resolved source-only presentation.
 * @returns Constructor `show` for the product BrowserWindow. Hidden must be false before any paint.
 */
export function desktopWindowConstructorOptions(
  presentation: DesktopWindowPresentation,
): { readonly show: boolean } {
  return Object.freeze({ show: presentation === 'visible' })
}

/**
 * Apply activate/second-instance presentation fencing to an existing window.
 *
 * Hidden presentation returns without restore or focus. Visible presentation
 * restores a minimized window and then focuses it.
 *
 * @param presentation Resolved source-only presentation.
 * @param target Existing product window, or `undefined` when none is live.
 * @returns `handled` when an existing window was fenced; `missing` when the caller must boot or recreate.
 */
export function handleDesktopWindowActivate(
  presentation: DesktopWindowPresentation,
  target: DesktopWindowActivateTarget | undefined,
): 'handled' | 'missing' {
  if (target === undefined || target.isDestroyed()) return 'missing'
  if (presentation === 'hidden') return 'handled'
  if (target.isMinimized()) target.restore()
  target.focus()
  return 'handled'
}

/** Next Desktop action after activate/second-instance presentation fencing. */
export type DesktopWindowReopenPlan = 'noop' | 'boot' | 'recreate'

/**
 * Plan boot versus recreate when activate fencing did not handle an existing window.
 *
 * @param hostReady Whether a Web Host URL is already published.
 * @returns `boot` when no Host exists; `recreate` when the Host is ready and the window must be constructed again.
 */
export function planDesktopWindowReopen(hostReady: boolean): Exclude<DesktopWindowReopenPlan, 'noop'> {
  return hostReady ? 'recreate' : 'boot'
}

/** Resolve local acceptance traffic directly without changing packaged proxy policy. */
export async function resolveDesktopNetworkProxy(options: {
  readonly packaged: boolean
  readonly environment: NodeJS.ProcessEnv
  readonly url: string
  readonly resolve: (url: string) => Promise<string>
}): Promise<string> {
  if (!options.packaged
    && options.environment.DSH_DESKTOP_E2E === '1'
    && options.environment.DSH_DESKTOP_E2E_DIRECT_NETWORK === '1') return 'DIRECT'
  return options.resolve(options.url)
}
