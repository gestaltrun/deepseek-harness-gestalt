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

/** Apply one runner-authored profile before the Desktop boots its owners. */
export function applyDesktopE2EProfile(options: {
  readonly packaged: boolean
  readonly argv: readonly string[]
  readonly environment: NodeJS.ProcessEnv
}): string | undefined {
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
  for (const [name, field] of Object.entries(value)) {
    if (!ALLOWED_ENVIRONMENT.has(name)) throw new TypeError(`Desktop E2E profile contains unknown field ${name}`)
    if (typeof field !== 'string' || field.length === 0) {
      throw new TypeError(`Desktop E2E profile field ${name} must be a non-empty string`)
    }
    options.environment[name] = field
  }
  return path
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
