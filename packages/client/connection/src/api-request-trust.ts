/**
 * Browser-trust fence for every /api request. Defends the two confused-deputy
 * paths a browser opens against a local HTTP API — DNS rebinding (Host names
 * the attacker's domain while the socket reaches this server) and cross-site
 * requests fired from a malicious page. The Host fence binds every request,
 * browser-looking or not: over plain HTTP a browser attaches neither Origin
 * nor Fetch-Metadata to reads (images and navigations — those
 * headers go only to trustworthy destinations), so an unmarked request may
 * still be a rebound browser read and Host is the one header rebinding cannot
 * forge. Non-browser and remote clients pass the same fence via loopback,
 * deployment-derived LAN IP literals, or a declared `trustedHosts` authority.
 * Network reachability and authentication stay out of scope: binding policy
 * belongs to the webserver config, and this fence is not an auth layer.
 * The Host/Origin/Fetch-Metadata judgment is shared with the phone-stream
 * routes through `@deepseek-ai/dsh-request-trust`; this module keeps the
 * /api-facing exports.
 */

import { isBareAuthority } from '@deepseek-ai/dsh-request-trust'

export { isTrustedApiRequest } from '@deepseek-ai/dsh-request-trust'

/**
 * Assert one configured `trustedHosts` entry is a bare authority (`host` or
 * `host:port`) in canonical form: it must survive WHATWG parsing unchanged
 * (case aside). Anything parsing would silently rewrite is refused as a typo
 * that must fail the load loudly instead of being ignored until requests 403
 * or quietly changing the grant.
 * @param entry - the configured value, verbatim.
 */
export function assertTrustedAuthority(entry: string): void {
  if (isBareAuthority(entry)) return
  throw new Error(`client-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}
