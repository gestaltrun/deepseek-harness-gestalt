/** Electron system-network adapters for Desktop-owned Platform HTTP and Relay WSS. */

import type { Agent } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'

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
 * Select an HTTP CONNECT agent from Electron proxy resolution rules.
 * @param rules - Semicolon-delimited result from `Session.resolveProxy`.
 * @returns proxy agent, or `undefined` when the first applicable directive is DIRECT.
 */
export function desktopRelayProxyAgent(rules: string): Agent | undefined {
  for (const rawDirective of rules.split(';')) {
    const directive = rawDirective.trim()
    if (directive === '') continue
    if (directive === 'DIRECT') return undefined
    const match = /^(PROXY|HTTPS)\s+(\S+)$/u.exec(directive)
    if (match === null) {
      throw new TypeError(`Desktop Relay system proxy directive is unsupported: ${directive.split(/\s+/u)[0]}`)
    }
    const protocol = match[1] === 'HTTPS' ? 'https:' : 'http:'
    const authority = match[2]
    if (authority === undefined) throw new TypeError('Desktop Relay system proxy has no authority')
    const url = new URL(`${protocol}//${authority}`)
    if (url.hostname === '' || url.port === '') throw new TypeError('Desktop Relay system proxy is invalid')
    return new HttpsProxyAgent(url)
  }
  return undefined
}
