import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  IndexedDbInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
} from '@deepseek-ai/dsh-platform-account-client'
import { loadPlatformEnvironment, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import {
  BrowserRelayEndpointSocket,
  MobileRelayEndpointLifecycle,
  RemoteAccessHttpTransport,
} from '@deepseek-ai/dsh-remote-access-client'
import { parseRelayAttachmentId, REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css'
import {
  bindCompanionProcessVisibility,
  CompanionForegroundRuntime,
  installCompanionRuntime,
} from './companion-push.ts'
import { MobileAccount } from './MobileAccount.tsx'
import type { MobilePairingActions } from './MobilePairing.tsx'
import { MobilePairingController, NativeMobilePairingQrScanner } from './personal-pairing.ts'
import {
  DevelopmentCompanionClient,
  DevelopmentCompanionSessionStore,
  bindDevelopmentCompanionCache,
  createDevelopmentCompanionCache,
  installDevelopmentCompanionClient,
} from './development-keyless-companion.ts'
import { mobileSystemBrowser } from './system-browser.ts'
import {
  createLoopbackPageFetch,
  rewriteLoopbackPlatformUrl,
  rewriteLoopbackRelayUrl,
} from './loopback-page-origin.ts'
import './root.css'

const DEVELOPMENT_KEYLESS_DESKTOP_ATTACHMENT_ID = parseRelayAttachmentId('desktop-development-keyless')
const DEVELOPMENT_KEYLESS_MOBILE_ATTACHMENT_ID = parseRelayAttachmentId('mobile-development-keyless')
const DEVELOPMENT_KEYLESS_SYNC_CIPHERTEXT = Uint8Array.of(1)

const environment = loadPlatformEnvironment({
  selection: import.meta.env.VITE_PLATFORM_ENV,
  development: {
    origin: import.meta.env.VITE_PLATFORM_DEVELOPMENT_ORIGIN,
    callbackUrl: import.meta.env.VITE_PLATFORM_DEVELOPMENT_CALLBACK_URL,
    githubClientId: import.meta.env.VITE_PLATFORM_DEVELOPMENT_GITHUB_CLIENT_ID,
    credentialReference: import.meta.env.VITE_PLATFORM_DEVELOPMENT_CREDENTIAL_REFERENCE,
    databaseIdentity: import.meta.env.VITE_PLATFORM_DEVELOPMENT_DATABASE_IDENTITY,
    identityNamespace: import.meta.env.VITE_PLATFORM_DEVELOPMENT_IDENTITY_NAMESPACE,
  },
  production: {
    origin: import.meta.env.VITE_PLATFORM_PRODUCTION_ORIGIN,
    callbackUrl: import.meta.env.VITE_PLATFORM_PRODUCTION_CALLBACK_URL,
    githubClientId: import.meta.env.VITE_PLATFORM_PRODUCTION_GITHUB_CLIENT_ID,
    credentialReference: import.meta.env.VITE_PLATFORM_PRODUCTION_CREDENTIAL_REFERENCE,
    databaseIdentity: import.meta.env.VITE_PLATFORM_PRODUCTION_DATABASE_IDENTITY,
    identityNamespace: import.meta.env.VITE_PLATFORM_PRODUCTION_IDENTITY_NAMESPACE,
  },
})
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
const pageOrigin = window.location.origin
const fetch = createLoopbackPageFetch(pageOrigin, environment.origin)
const installation = new PlatformAccountInstallation({
  environment,
  installationId: parsedInstallationId,
  installationKind: 'mobile',
  transport: new PlatformAccountHttpTransport({ environment, fetch }),
  store: new IndexedDbInstallationAccountStore(`deepseek-gestalt-platform-account:${environment.databaseIdentity}`),
  systemBrowser: {
    open(url) {
      return mobileSystemBrowser.open(rewriteLoopbackPlatformUrl(url, pageOrigin, environment.origin))
    },
  },
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
if (environment.environment === 'development' && import.meta.env.VITE_PERSONAL_PAIRING_KEYLESS === '1') {
  const { DevelopmentKeylessMobileHandshakeClient } = await import('./development-keyless-pairing.ts')
  const { PairingCompanionKeyVault } = await import('./companion-keys.ts')
  const relayUrl = rewriteLoopbackRelayUrl(
    requiredWss(import.meta.env.VITE_REMOTE_RELAY_WSS_URL),
    pageOrigin,
    environment.origin,
  )
  const inboundMaxBytes = positiveInteger(import.meta.env.VITE_REMOTE_RELAY_INBOUND_MAX_BYTES, 'inbound bytes')
  const inboundMaxMessages = positiveInteger(import.meta.env.VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES, 'inbound messages')
  if (inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('Mobile Relay inbound bytes must admit one maximum Relay message')
  }
  const companionSessions = new DevelopmentCompanionSessionStore()
  const companionRef: { client?: DevelopmentCompanionClient } = {}
  const relay = new MobileRelayEndpointLifecycle({
    attachmentId: () => DEVELOPMENT_KEYLESS_MOBILE_ATTACHMENT_ID,
    connect: async signal => await BrowserRelayEndpointSocket.connect(relayUrl, signal, {
      maxBytes: inboundMaxBytes,
      maxMessages: inboundMaxMessages,
    }),
    attachTimeoutMs: positiveInteger(import.meta.env.VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS, 'attach timeout'),
    heartbeatIntervalMs: positiveInteger(import.meta.env.VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS, 'heartbeat interval'),
    reconnectDelayMs: positiveInteger(import.meta.env.VITE_REMOTE_RELAY_RECONNECT_DELAY_MS, 'reconnect delay'),
    onCiphertext: (ciphertext) => { void companionRef.client?.receive(ciphertext) },
  })
  const developmentCompanion = new DevelopmentCompanionClient(
    companionSessions,
    async (target, ciphertext) => { await relay.sendCiphertext(target, ciphertext) },
    DEVELOPMENT_KEYLESS_DESKTOP_ATTACHMENT_ID,
  )
  companionRef.client = developmentCompanion
  installDevelopmentCompanionClient(developmentCompanion)
  const boundAccounts = new Set<string>()
  installation.subscribe(() => {
    const snapshot = installation.getSnapshot()
    if (snapshot.status !== 'signed-in' || snapshot.account === undefined) return
    if (boundAccounts.has(snapshot.account.id)) return
    boundAccounts.add(snapshot.account.id)
    const cache = createDevelopmentCompanionCache(environment.environment, snapshot.account.id)
    void bindDevelopmentCompanionCache(companionSessions, cache)
  })
  const companion = new CompanionForegroundRuntime({
    relay: {
      configure: (grant) => { relay.configure(grant) },
      start: async () => {
        await relay.start()
        if (!relay.isConnected()) return
        try {
          await relay.sendCiphertext(DEVELOPMENT_KEYLESS_DESKTOP_ATTACHMENT_ID, DEVELOPMENT_KEYLESS_SYNC_CIPHERTEXT)
        } catch (error) {
          if (error instanceof RemoteRelayError && error.code === 'REMOTE_OFFLINE') return
          throw error
        }
      },
      stop: async () => { await relay.stop() },
      isConnected: () => relay.isConnected(),
    },
  })
  installCompanionRuntime(companion)
  companionVisibilityDisposer = bindCompanionProcessVisibility(companion)
  pairing = new MobilePairingController({
    installation,
    transport: new RemoteAccessHttpTransport({ environment, fetch }),
    handshake: new DevelopmentKeylessMobileHandshakeClient(),
    scanner: new NativeMobilePairingQrScanner(),
    relay: companion,
    companion,
    pairingKeys: new PairingCompanionKeyVault(),
    device: {
      name: navigator.userAgent.includes('Android') ? 'Android phone' : 'iPhone',
      platform: navigator.userAgent.includes('Android') ? 'android' : 'ios',
    },
  })
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
createRoot(root).render(
  <StrictMode>
    <MobileAccount installation={installation} pairing={pairing} />
  </StrictMode>,
)
