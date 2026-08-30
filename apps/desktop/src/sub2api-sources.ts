/**
 * Download sources for the optional Sub2API sidecar component.
 *
 * The offer card downloads two artifacts on enablement: the `dsh-sub2api-sidecar`
 * bundle tarball (an npm `dsh.bundle` package) and the per-platform runtime pack
 * tarball (sub2api + portable PostgreSQL/Redis, built by the sidecar repository's
 * CI). Each archive is verified against its own `SHA256SUMS` file before any file
 * reaches `$DSH_HOME`.
 *
 * The sources are deployment configuration, not code: they resolve from a JSON
 * file (`DSH_DESKTOP_SUB2API_SOURCES` path override, otherwise
 * `sub2api-sources.json` beside the packaged main entry, mirroring the operated
 * Platform configuration). Without the file the deployment has no component
 * source, and the offer card states that configuration failure instead of
 * pretending a default feed exists.
 * @module @deepseek-ai/dsh-desktop/sub2api-sources
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Environment variable holding an absolute path to the sources JSON file. */
export const SUB2API_SOURCES_ENV = 'DSH_DESKTOP_SUB2API_SOURCES'

/** The four download sources one enablement needs. */
export interface DesktopSub2ApiSources {
  /** Bundle tarball (npm `dsh.bundle` package, `pnpm pack` output). */
  readonly bundleUrl: string
  /** `SHA256SUMS` file covering the bundle tarball. */
  readonly bundleSha256SumsUrl: string
  /** Runtime pack tarball (sub2api + PostgreSQL/Redis, per os/arch). */
  readonly runtimePackUrl: string
  /** `SHA256SUMS` file covering the runtime pack tarball. */
  readonly runtimePackSha256SumsUrl: string
}

const REQUIRED_FIELDS = [
  'bundleUrl',
  'bundleSha256SumsUrl',
  'runtimePackUrl',
  'runtimePackSha256SumsUrl',
] as const

/** Absolute http(s) origin check; the sources are network URLs, not file paths. */
function requireHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Desktop Sub2API sources require ${field} as a non-empty string`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`Desktop Sub2API sources field ${field} is not an absolute URL: ${value}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`Desktop Sub2API sources field ${field} must be an http(s) URL: ${value}`)
  }
  return value
}

/**
 * Parse and validate one sources document. Unknown fields are rejected so a
 * renamed key fails loud instead of silently leaving that source at the default.
 * @param value - parsed JSON value of the sources file.
 * @returns the validated sources.
 */
export function parseDesktopSub2ApiSources(value: unknown): DesktopSub2ApiSources {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop Sub2API sources must be a JSON object')
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(field => !REQUIRED_FIELDS.includes(field as never))
  if (unknown.length > 0) {
    throw new TypeError(`Desktop Sub2API sources contain unknown fields: ${unknown.join(', ')}`)
  }
  return {
    bundleUrl: requireHttpUrl(record['bundleUrl'], 'bundleUrl'),
    bundleSha256SumsUrl: requireHttpUrl(record['bundleSha256SumsUrl'], 'bundleSha256SumsUrl'),
    runtimePackUrl: requireHttpUrl(record['runtimePackUrl'], 'runtimePackUrl'),
    runtimePackSha256SumsUrl: requireHttpUrl(record['runtimePackSha256SumsUrl'], 'runtimePackSha256SumsUrl'),
  }
}

/**
 * Resolve the sources file path: the environment override when set, otherwise
 * the conventional location beside the main entry.
 * @param moduleUrl - `import.meta.url` of the caller (the packaged main entry).
 * @returns the candidate path (which may not exist).
 */
export function resolveSub2ApiSourcesPath(moduleUrl: string): string {
  const override = process.env[SUB2API_SOURCES_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const here = dirname(fileURLToPath(moduleUrl))
  return join(here, 'sub2api-sources.json')
}

/**
 * Read the Sub2API download sources.
 * @param moduleUrl - `import.meta.url` of the caller.
 * @returns the validated sources, or `undefined` when no sources file exists
 *   (the placeholder state: the deployment has no component source).
 * @throws when a sources file exists but is unreadable or invalid.
 */
export function readDesktopSub2ApiSources(moduleUrl: string): DesktopSub2ApiSources | undefined {
  const path = resolveSub2ApiSourcesPath(moduleUrl)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new TypeError(`Desktop Sub2API sources file ${path} is not valid JSON: ${String(error)}`)
  }
  try {
    return parseDesktopSub2ApiSources(parsed)
  } catch (error) {
    throw new TypeError(`${String(error)} (${path})`)
  }
}
