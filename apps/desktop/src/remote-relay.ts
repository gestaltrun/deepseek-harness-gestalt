/** Desktop Host composition for the product-gated Remote Relay endpoint. */

import type { SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayAttachmentId,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'
import type { RelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client'
import {
  DesktopRelayEndpointLifecycle,
  FailClosedDesktopRelayLifecycle,
  type DesktopRelayLifecycle,
} from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import { NodeRelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client/node-relay-socket'
import {
  DEVELOPMENT_COMPANION_STREAM_DELAY_MS,
  DevelopmentKeylessCompanionAuthority,
} from './development-keyless-companion.ts'
import { isLoopbackListenUrl } from './loopback-listen-trust.ts'

const CRYPTO_GATE = 'Personal Pairing requires an independently reviewed handshake and Relay crypto provider.'

/** Keyless Desktop attachment shared with the Mobile development entry. */
export const DEVELOPMENT_KEYLESS_DESKTOP_ATTACHMENT_ID = parseRelayAttachmentId('desktop-development-keyless')
/** Keyless Mobile attachment that Desktop addresses for development resync. */
export const DEVELOPMENT_KEYLESS_MOBILE_ATTACHMENT_ID = parseRelayAttachmentId('mobile-development-keyless')
/** One-byte development sync frame; it is not product Companion ciphertext. */
export const DEVELOPMENT_KEYLESS_SYNC_CIPHERTEXT = Uint8Array.of(1)

/** Validated Desktop endpoint deployment inputs. */
export interface DesktopRemoteRelayConfig {
  url: string
  attachTimeoutMs: number
  heartbeatIntervalMs: number
  reconnectDelayMs: number
  inboundMaxBytes: number
  inboundMaxMessages: number
}

/** Product composition dependencies for a Desktop Relay lifecycle. */
export interface DesktopRemoteRelayOptions {
  environment: SelectedPlatformEnvironment
  source: NodeJS.ProcessEnv | Record<string, string | undefined>
  connect?: (signal: AbortSignal, config: DesktopRemoteRelayConfig) => Promise<RelayEndpointSocket>
}

/**
 * Parse the complete Desktop WSS bundle before network acquisition.
 * @param source - Desktop process environment.
 * @returns validated WSS and bounded queue inputs.
 */
export function loadDesktopRemoteRelayConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DesktopRemoteRelayConfig {
  const url = required(source, 'DSH_REMOTE_RELAY_WSS_URL')
  if (new URL(url).protocol !== 'wss:') throw new TypeError('DSH_REMOTE_RELAY_WSS_URL must use WSS')
  const config: DesktopRemoteRelayConfig = {
    url,
    attachTimeoutMs: positiveInteger(source, 'DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS'),
    heartbeatIntervalMs: positiveInteger(source, 'DSH_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS'),
    reconnectDelayMs: positiveInteger(source, 'DSH_REMOTE_RELAY_RECONNECT_DELAY_MS'),
    inboundMaxBytes: positiveInteger(source, 'DSH_REMOTE_RELAY_INBOUND_MAX_BYTES'),
    inboundMaxMessages: positiveInteger(source, 'DSH_REMOTE_RELAY_INBOUND_MAX_MESSAGES'),
  }
  if (config.inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('DSH_REMOTE_RELAY_INBOUND_MAX_BYTES must admit one maximum Relay message')
  }
  return config
}

/**
 * Select the observable production crypto gate or the explicit development endpoint.
 * @param options - Platform environment, process configuration, and optional socket adapter.
 * @returns Desktop-owned Relay lifecycle injected into Settings.
 */
export function createDesktopRemoteRelay(options: DesktopRemoteRelayOptions): DesktopRelayLifecycle {
  if (options.environment.environment !== 'development'
    || options.source.DSH_PERSONAL_PAIRING_KEYLESS !== '1') {
    return new FailClosedDesktopRelayLifecycle(CRYPTO_GATE)
  }
  const config = loadDesktopRemoteRelayConfig(options.source)
  const connect = options.connect ?? (async (signal: AbortSignal) => await NodeRelayEndpointSocket.connect(
    config.url,
    signal,
    { maxBytes: config.inboundMaxBytes, maxMessages: config.inboundMaxMessages },
    isLoopbackListenUrl(config.url) ? { rejectUnauthorized: false } : undefined,
  ))
  let lastSourceAttachmentId = DEVELOPMENT_KEYLESS_MOBILE_ATTACHMENT_ID
  const relay: { lifecycle?: DesktopRelayEndpointLifecycle } = {}
  const authority = new DevelopmentKeylessCompanionAuthority({
    streamDelayMs: DEVELOPMENT_COMPANION_STREAM_DELAY_MS,
    emit: async (frames) => {
      const lifecycle = relay.lifecycle
      if (lifecycle === undefined) return
      for (const frame of frames) {
        await ignoreRemoteOffline(lifecycle.sendCiphertext(lastSourceAttachmentId, frame))
      }
    },
  })
  const lifecycle = new DesktopRelayEndpointLifecycle({
    attachmentId: () => DEVELOPMENT_KEYLESS_DESKTOP_ATTACHMENT_ID,
    connect: async signal => await connect(signal, config),
    attachTimeoutMs: config.attachTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectDelayMs: config.reconnectDelayMs,
    resynchronize: async (send) => {
      await ignoreRemoteOffline(
        send(DEVELOPMENT_KEYLESS_MOBILE_ATTACHMENT_ID, DEVELOPMENT_KEYLESS_SYNC_CIPHERTEXT),
      )
    },
    onCiphertext: async (ciphertext, sourceAttachmentId) => {
      lastSourceAttachmentId = sourceAttachmentId
      for (const reply of await authority.reply(ciphertext)) {
        await ignoreRemoteOffline(lifecycle.sendCiphertext(sourceAttachmentId, reply))
      }
    },
  })
  relay.lifecycle = lifecycle
  return lifecycle
}

async function ignoreRemoteOffline(operation: Promise<void>): Promise<void> {
  try {
    await operation
  } catch (error) {
    if (error instanceof RemoteRelayError && error.code === 'REMOTE_OFFLINE') return
    throw error
  }
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} must be configured`)
  return value
}

function positiveInteger(source: Record<string, string | undefined>, name: string): number {
  const value = Number(required(source, name))
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}
