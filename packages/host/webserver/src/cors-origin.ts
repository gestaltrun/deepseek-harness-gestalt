/** Exact CORS Origin validation shared by HTTP route owners. */

/**
 * Validated allowlist that preserves configured tuple origins, including a
 * custom-scheme origin, without ever treating the opaque `null` value as one.
 */
export class CorsOriginPolicy {
  private readonly origins: ReadonlySet<string>

  /**
   * @param values - Exact serialized origins admitted by the caller.
   * @param owner - Diagnostic owner of the configuration.
   */
  constructor(values: readonly string[], owner: string) {
    if (values.length === 0) {
      throw new TypeError(`${owner} origins configuration is required`)
    }
    const origins = new Set<string>()
    for (const value of values) {
      const origin = parseOrigin(value)
      if (origin === undefined) throw new TypeError(`${owner} origin is invalid: ${JSON.stringify(value)}`)
      if (origins.has(origin)) throw new TypeError(`${owner} origin is duplicated: ${JSON.stringify(origin)}`)
      origins.add(origin)
    }
    this.origins = origins
  }

  /**
   * Match one request Origin against the validated exact allowlist.
   * @param value - Raw request Origin header.
   * @returns Canonical configured origin, or `undefined` when it is not admitted.
   */
  match(value: string): string | undefined {
    const origin = parseOrigin(value)
    return origin !== undefined && this.origins.has(origin) ? origin : undefined
  }
}

function parseOrigin(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return value === url.origin ? value : undefined
  }
  if (url.hostname === '' || url.port !== '' || url.pathname !== '') return undefined
  const normalized = `${url.protocol}//${url.hostname}`
  return value === normalized ? normalized : undefined
}
