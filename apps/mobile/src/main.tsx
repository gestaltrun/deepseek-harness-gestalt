import {
  IndexedDbInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
} from '@deepseek-ai/dsh-platform-account-client'
import { parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  BrowserRelayEndpointSocket,
  MobileRelayEndpointLifecycle,
  RemoteAccessHttpTransport,
} from '@deepseek-ai/dsh-remote-access-client'
import { parseRelayAttachmentId, REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import {
  SnowMobileAttachmentOwner,
  SnowMobileHandshakeClient,
  type SnowCompanionProtocolChannel,
} from '@deepseek-ai/dsh-noise-channel'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css'
import {
  bindCompanionProcessVisibility,
  CompanionForegroundRuntime,
  companionRuntime,
  installCompanionRuntime,
} from './companion-lifecycle.ts'
import { mountMobileEntry } from './mobile-entry.tsx'
import { MobileNoiseCompanionReceiver } from './noise-companion.ts'
import type { MobilePairingActions } from './MobilePairing.tsx'
import { MobilePairingController, NativeMobilePairingQrScanner } from './personal-pairing.ts'
import { IndexedDbMobilePairingStateStore, PairingCompanionKeyVault } from './companion-keys.ts'
import { mobileSystemBrowser } from './system-browser.ts'
import { loadMobilePlatformEnvironment } from './platform-environment.ts'
import './root.css'

const environment = loadMobilePlatformEnvironment(import.meta.env)
const installationIdKey = `deepseek-gestalt:${environment.identityNamespace}:mobile-installation-id`
let installationId = localStorage.getItem(installationIdKey)
if (installationId === null) {
  if (typeof crypto.randomUUID !== 'function') {
    throw new TypeError('Mobile requires a secure browsing context (HTTPS or http://127.0.0.1) to create an Installation id')
  }
  installationId = crypto.randomUUID()
  localStorage.setItem(installationIdKey, installationId)
}
const parsedInstallationId = parseInstallationId(installationId)
const installation = new PlatformAccountInstallation({
  environment,
  installationId: parsedInstallationId,
  installationKind: 'mobile',
  transport: new PlatformAccountHttpTransport({ environment }),
  store: new IndexedDbInstallationAccountStore(`deepseek-gestalt-platform-account:${environment.databaseIdentity}`),
  systemBrowser: mobileSystemBrowser,
})
let companionVisibilityDisposer: (() => Promise<void>) | undefined

/**
 * Remove the process-lifetime visibility listeners bound by the Mobile entry.
 * @returns settled after document listeners and a pending Capacitor handle are removed.
 */
export function disposeCompanionVisibility(): Promise<void> {
  return companionVisibilityDisposer?.() ?? Promise.resolve()
}

const unavailablePairing = {
  status: 'unavailable',
  error: 'Personal Pairing waits for the independent Noise security review.',
} as const
const pairingUnavailable = (): Promise<never> => Promise.reject(new Error(unavailablePairing.error))
let pairing: MobilePairingActions = {
  getSnapshot: () => unavailablePairing,
  subscribe: () => () => {},
  completeLink: pairingUnavailable,
  scanQr: pairingUnavailable,
  retryPairing: pairingUnavailable,
  activate: () => Promise.resolve(),
  deactivate: () => Promise.resolve(),
  unpair: pairingUnavailable,
}
let companion: CompanionForegroundRuntime
if (environment.environment === 'production') {
  const relayUrl = requiredWss(import.meta.env.VITE_REMOTE_RELAY_WSS_URL)
  const inboundMaxBytes = positiveInteger(import.meta.env.VITE_REMOTE_RELAY_INBOUND_MAX_BYTES, 'inbound bytes')
  const inboundMaxMessages = positiveInteger(import.meta.env.VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES, 'inbound messages')
  if (inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('Mobile Relay inbound bytes must admit one maximum Relay message')
  }
  const handshake = new SnowMobileHandshakeClient()
  const pairingKeys = new PairingCompanionKeyVault(new IndexedDbMobilePairingStateStore(
    `deepseek-gestalt:${environment.databaseIdentity}:mobile-snow-pairings`,
  ))
  let attachmentOwner: SnowMobileAttachmentOwner | undefined
  let channel: SnowCompanionProtocolChannel | undefined
  let receiver: MobileNoiseCompanionReceiver | undefined
  let connectionGeneration: number | undefined
  let activeSourceAttachmentId: ReturnType<typeof parseRelayAttachmentId> | undefined
  let pendingGeneration: number | undefined
  const clearNoiseConnection = (): void => {
    attachmentOwner?.dispose()
    attachmentOwner = undefined
    channel?.dispose()
    channel = undefined
    receiver = undefined
    connectionGeneration = undefined
    activeSourceAttachmentId = undefined
    pendingGeneration = undefined
  }
  const relay = new MobileRelayEndpointLifecycle({
    attachmentId: () => parseRelayAttachmentId(crypto.randomUUID()),
    connect: async signal => await BrowserRelayEndpointSocket.connect(relayUrl, signal, {
      maxBytes: inboundMaxBytes,
      maxMessages: inboundMaxMessages,
    }),
    attachTimeoutMs: positiveInteger(import.meta.env.VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS, 'attach timeout'),
    heartbeatIntervalMs: positiveInteger(import.meta.env.VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS, 'heartbeat interval'),
    reconnectDelayMs: positiveInteger(import.meta.env.VITE_REMOTE_RELAY_RECONNECT_DELAY_MS, 'reconnect delay'),
    onPeerAttachments: async (ready) => {
      const peer = ready.peers[0]
      if (peer === undefined || ready.peers.length !== 1) {
        attachmentOwner?.dispose()
        attachmentOwner = undefined
        pendingGeneration = undefined
        if (ready.peers.length > 1) throw new Error('Mobile Relay has multiple Desktop pairing peers')
        return
      }
      if (peer.generation === connectionGeneration || peer.generation === pendingGeneration) return
      const reconnectState = pairingKeys.pairingKeyMaterial(parsePersonalPairingId(peer.pairingSelector))
      if (reconnectState === undefined) throw new Error('Mobile Relay peer has no retained Snow pairing state')
      attachmentOwner?.dispose()
      pendingGeneration = peer.generation
      attachmentOwner = new SnowMobileAttachmentOwner(reconnectState, peer.pairingSelector)
      reconnectState.fill(0)
      const begun = await attachmentOwner.begin(ready)
      await relay.sendCiphertext(begun.targetAttachmentId, begun.payload)
    },
    onCiphertext: (ciphertext, sourceAttachmentId) => {
      if (receiver !== undefined && sourceAttachmentId === activeSourceAttachmentId) {
        receiver.receive(ciphertext)
        return
      }
      if (attachmentOwner === undefined) throw new Error('Mobile Relay ciphertext has no pending Snow IK owner')
      if (pendingGeneration === undefined) throw new Error('Mobile Relay ciphertext has no Snow generation')
      const nextChannel = attachmentOwner.finish(ciphertext, sourceAttachmentId)
      attachmentOwner.dispose()
      channel?.dispose()
      channel = nextChannel
      connectionGeneration = pendingGeneration
      pendingGeneration = undefined
      activeSourceAttachmentId = sourceAttachmentId
      attachmentOwner = undefined
      receiver = new MobileNoiseCompanionReceiver(channel, connectionGeneration, companion)
    },
    onConnectionReady: () => { companionRuntime()?.markConnectionOpen() },
    onConnectionLost: () => { clearNoiseConnection(); companionRuntime()?.forgetConnection() },
    onTransportError: () => { clearNoiseConnection(); companionRuntime()?.forgetConnection() },
  })
  companion = new CompanionForegroundRuntime({ relay })
  installCompanionRuntime(companion)
  companionVisibilityDisposer = bindCompanionProcessVisibility(companion)
  pairing = new MobilePairingController({
    installation,
    transport: new RemoteAccessHttpTransport({ environment }),
    handshake,
    pairingKeys,
    scanner: new NativeMobilePairingQrScanner(),
    relay: companion,
    companion,
    device: {
      name: navigator.userAgent.includes('Android') ? 'Android phone' : 'iPhone',
      platform: navigator.userAgent.includes('Android') ? 'android' : 'ios',
    },
  })
} else {
  companion = new CompanionForegroundRuntime()
  installCompanionRuntime(companion)
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`Mobile Relay ${name} must be a positive integer`)
  return parsed
}

function requiredWss(value: unknown): string {
  if (typeof value !== 'string' || new URL(value).protocol !== 'wss:') throw new TypeError('Mobile Relay endpoint must use WSS')
  return value
}
const root = document.getElementById('root')
if (root === null) throw new Error('mobile app: missing #root')
mountMobileEntry(root, { installation, pairing, companion })
