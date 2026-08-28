/** Electron system-network adapters for Desktop-owned Platform HTTP and Relay WSS. */

import type { Agent } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'

/** One ordered Electron proxy directive for a Relay connection attempt. */
export interface DesktopRelayProxyCandidate {
  /** Native HTTP CONNECT agent; absence means a direct connection. */
  agent?: Agent
  /** Credential-free proxy URL suitable for the system-Node Relay helper. */
  proxyUrl?: string
  /** Content-free directive used for diagnostics and tests. */
  directive: 'DIRECT' | 'PROXY' | 'HTTPS'
}

/**
 * Adapt Electron `net.fetch` to the shared Fetch interface.
 * @param fetch - Electron session-aware fetch implementation.
 * @returns Fetch implementation that follows Chromium system proxy policy.
 */
export function desktopSystemFetch(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => await fetch(input, init)
}

/**
 * Preserve the ordered connection candidates from Electron proxy resolution rules.
 * @param rules - Semicolon-delimited result from `Session.resolveProxy`.
 * @returns ordered CONNECT and direct candidates.
 */
export function desktopRelayProxyCandidates(rules: string): readonly DesktopRelayProxyCandidate[] {
  const candidates: DesktopRelayProxyCandidate[] = []
  for (const rawDirective of rules.split(';')) {
    const directive = rawDirective.trim()
    if (directive === '') continue
    if (directive === 'DIRECT') {
      candidates.push({ directive: 'DIRECT' })
      continue
    }
    const match = /^(PROXY|HTTPS)\s+(\S+)$/u.exec(directive)
    if (match === null) {
      throw new TypeError(`Desktop Relay system proxy directive is unsupported: ${directive.split(/\s+/u)[0]}`)
    }
    const protocol = match[1] === 'HTTPS' ? 'https:' : 'http:'
    const authority = match[2]
    if (authority === undefined) throw new TypeError('Desktop Relay system proxy has no authority')
    const url = new URL(`${protocol}//${authority}`)
    if (url.hostname === '' || url.port === '') throw new TypeError('Desktop Relay system proxy is invalid')
    if (url.username !== '' || url.password !== '') {
      throw new TypeError('Desktop Relay system proxy must not contain credentials')
    }
    candidates.push({
      directive: match[1] as 'PROXY' | 'HTTPS',
      agent: new HttpsProxyAgent(url),
      proxyUrl: url.href,
    })
  }
  return candidates.length === 0 ? [{ directive: 'DIRECT' }] : candidates
}
