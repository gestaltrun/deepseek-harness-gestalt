/** Rewrite loopback HTTPS Platform URLs onto an untrusted-certificate HTTP page origin. */

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

/**
 * Map a selected HTTPS loopback Platform URL onto the current loopback HTTP page.
 * Pairing links keep the HTTPS origin; only same-origin page traffic is rewritten.
 * @param url - Account, pairing, authorization, or Relay URL.
 * @param pageOrigin - current browsing-context origin.
 * @param platformOrigin - selected Platform environment origin.
 * @returns the page-origin URL when both sides are loopback HTTP←HTTPS; otherwise `url`.
 */
export function rewriteLoopbackPlatformUrl(url: string, pageOrigin: string, platformOrigin: string): string {
  const page = new URL(pageOrigin)
  const platform = new URL(platformOrigin)
  const target = new URL(url)
  if (!isLoopbackHostname(page.hostname) || !isLoopbackHostname(platform.hostname)) return url
  if (page.protocol !== 'http:' || platform.protocol !== 'https:') return url
  if (target.origin !== platform.origin) return url
  return new URL(`${target.pathname}${target.search}${target.hash}`, page.origin).href
}

/**
 * Map the configured WSS listen onto `ws:` through the current loopback HTTP page.
 * @param wssUrl - validated `wss:` Relay URL.
 * @param pageOrigin - current browsing-context origin.
 * @param platformOrigin - selected Platform environment origin.
 * @returns a loopback `ws:` URL when the page cannot present the listen certificate; otherwise `wssUrl`.
 */
export function rewriteLoopbackRelayUrl(wssUrl: string, pageOrigin: string, platformOrigin: string): string {
  const asHttps = wssUrl.replace(/^wss:/, 'https:')
  const rewritten = rewriteLoopbackPlatformUrl(asHttps, pageOrigin, platformOrigin)
  return rewritten === asHttps ? wssUrl : rewritten.replace(/^http:/, 'ws:')
}

/**
 * Fetch that rewrites selected HTTPS loopback Platform requests onto the page origin.
 * @param pageOrigin - current browsing-context origin.
 * @param platformOrigin - selected Platform environment origin.
 * @returns a Fetch implementation bound to the global.
 */
export function createLoopbackPageFetch(pageOrigin: string, platformOrigin: string): typeof fetch {
  const bound = globalThis.fetch.bind(globalThis)
  return (input, init) => {
    if (input instanceof Request) {
      const next = rewriteLoopbackPlatformUrl(input.url, pageOrigin, platformOrigin)
      if (next === input.url) return bound(input, init)
      return bound(new Request(next, input), init)
    }
    const url = typeof input === 'string' ? input : input.href
    return bound(rewriteLoopbackPlatformUrl(url, pageOrigin, platformOrigin), init)
  }
}
