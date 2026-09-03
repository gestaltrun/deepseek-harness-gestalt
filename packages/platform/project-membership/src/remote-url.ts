/**
 * Git remote URL normalization for project binding. A stored project keeps
 * one canonical spelling of the workspace Git origin or Git-less
 * `local://workspace/<id>` sentinel so `projectByRemote` matches independently
 * of how a caller spells the same checkout.
 * @module @deepseek-ai/dsh-project-membership/remote-url
 */

import { ProjectMembershipError } from './errors.ts'

const invalidRemote = (input: string): ProjectMembershipError =>
  new ProjectMembershipError(
    'INVALID_REMOTE_URL',
    `"${input}" is not a normalized git remote URL (use https://host/path, user@host:path, or local://workspace/<id>)`,
  )

const LOCAL_WORKSPACE_REMOTE = /^local:\/\/workspace\/([^/?#]+)?$/i

/** One scp-like spelling's parsed components. */
interface ScpLikeRemote {
  readonly user: string
  readonly host: string
  readonly path: string
}

/**
 * Canonical Platform remote for a Workspace that has no Git origin.
 * @param workspaceId - exact local Workspace identity.
 * @returns `local://workspace/<id>` in canonical form.
 * @throws {ProjectMembershipError} `INVALID_REMOTE_URL` when the Workspace identity is empty or contains `/`, `?`, or `#`.
 */
export function localWorkspaceRemoteUrl(workspaceId: string): string {
  return normalizeGitRemoteUrl(`local://workspace/${workspaceId}`)
}

/**
 * Normalize one git remote URL to the canonical binding form: HTTPS spellings
 * lower-case scheme and host; scp-like `user@host:path` spellings lower-case
 * the host and keep the user and path case-exact; the Git-less Workspace
 * sentinel `local://workspace/<id>` keeps the Workspace identity case-exact;
 * every Git spelling drops one terminal `.git` repository suffix
 * (case-insensitive) and trailing slashes while keeping mid-path segments
 * untouched. Anything else is rejected rather than guessed.
 * @param input - caller-provided remote URL.
 * @returns the canonical remote URL recorded on the project.
 * @throws {ProjectMembershipError} `INVALID_REMOTE_URL` for blank input, unsupported schemes, or missing host/path.
 */
export function normalizeGitRemoteUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw invalidRemote(input)
  if (/^https?:\/\//i.test(trimmed)) return normalizeHttps(input, trimmed)
  const localWorkspace = LOCAL_WORKSPACE_REMOTE.exec(trimmed)
  if (localWorkspace !== null) {
    const workspaceId = localWorkspace[1] ?? ''
    if (workspaceId === '') throw invalidRemote(input)
    return `local://workspace/${workspaceId}`
  }
  const scpLike = parseScpLike(trimmed)
  if (scpLike !== undefined) {
    const path = stripGitSuffix(scpLike.path)
    if (scpLike.host === '' || path === '') throw invalidRemote(input)
    return `${scpLike.user}@${scpLike.host.toLowerCase()}:${path}`
  }
  throw invalidRemote(input)
}

/** Canonicalize one http(s) URL through the WHATWG parser. */
function normalizeHttps(rawInput: string, trimmed: string): string {
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw invalidRemote(rawInput)
  }
  const path = stripGitSuffix(url.pathname).replace(/\/+$/, '')
  if (url.hostname === '' || path === '') throw invalidRemote(rawInput)
  return `${url.protocol}//${url.host}${path}`
}

/** Parse `[user@]host:path`, keeping every component case-exact. */
function parseScpLike(value: string): ScpLikeRemote | undefined {
  const match = /^([^@/:]+)@([^/:]+):(.+)$/.exec(value)
  if (match === null) return undefined
  const [, user, host, path] = match as unknown as [string, string, string, string]
  return { user, host, path }
}

/** Strip exactly one terminal `.git` repository component, any casing. */
function stripGitSuffix(component: string): string {
  return component.replace(/\/\.git$/i, '').replace(/\.git$/i, '')
}
