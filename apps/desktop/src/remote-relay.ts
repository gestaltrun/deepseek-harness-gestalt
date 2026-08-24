/** Desktop Host composition for the product-gated Remote Relay endpoint. */

import {
  FailClosedDesktopRelayLifecycle,
  type DesktopRelayLifecycle,
} from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'

const CRYPTO_GATE = 'Personal Pairing requires an independently reviewed handshake and Relay crypto provider.'

/**
 * Keep Relay unavailable until the reviewed product channel is composed.
 * @returns fail-closed Desktop-owned Relay lifecycle injected into Settings.
 */
export function createDesktopRemoteRelay(): DesktopRelayLifecycle {
  return new FailClosedDesktopRelayLifecycle(CRYPTO_GATE)
}
