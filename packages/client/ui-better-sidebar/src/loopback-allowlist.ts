/** Shared host/client parser for the browser loopback allowlist. */

/**
 * Parse comma-separated loopback authorities into a host and port matcher.
 * @param allowlist - Bare hosts or exact host and port authorities.
 * @returns A predicate that accepts an allowlisted host and port pair.
 */
export function parseLoopbackAllowlist(allowlist: string): (host: string, port: string) => boolean {
  const entries = allowlist.split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '')
  const exact = new Set(entries)
  const hosts = new Set<string>()
  for (const entry of entries) {
    if (!entry.includes(':')) hosts.add(entry.replace(/^\[|\]$/g, ''))
  }
  return (host, port) => {
    const key = `${host}:${port}`
    if (exact.has(key) || exact.has(host)) return true
    return port !== '' && hosts.has(host)
  }
}
