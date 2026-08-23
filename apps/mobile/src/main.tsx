import { Device } from '@capacitor/device'
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
import {
  parseRelayAttachmentId,
  REMOTE_PROTOCOL_LIMITS,
  type RelayPairingSelector,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  SnowMobileAttachmentOwner,
  SnowMobileHandshakeClient,
  type SnowCompanionProtocolChannel,
} from '@deepseek-ai/dsh-noise-channel'
import '@deepseek-ai/dsh-client-ui-theme/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/styles/scrollbar.css'
import '@deepseek-ai/dsh-client-ui-theme/styles/gradient-shadow-text.css'
import '@deepseek-ai/dsh-client-ui-theme/styles/shiki.css'
import {
  bindCompanionProcessVisibility,
  CompanionForegroundRuntime,
  companionRuntime,
  installCompanionRuntime,
} from './companion-lifecycle.ts'
import { mountMobileEntry } from './mobile-entry.tsx'
import { MobileNoiseCompanionReceiver } from './noise-companion.ts'
import {
  MobileSnowCompanionConnection,
  MobileSnowCompanionProductChannel,
} from './noise-companion-product.ts'
import type {
  MobileCompanionConnectionChannel,
  MobileCompanionSurface,
} from './companion-surface.ts'
import type { MobilePairingActions } from './MobilePairing.tsx'
import { MobilePairingController, NativeMobilePairingQrScanner } from './personal-pairing.ts'
import { NativeMobilePairingStateStore, PairingCompanionKeyVault } from './companion-keys.ts'
import { mobileInstallationPresentation } from './mobile-installation.ts'
import { bindMobilePairingDeepLinks } from './mobile-deep-links.ts'
import type { MobilePairingDeepLinkBinding } from './mobile-deep-links.ts'
import {
  CapacitorMobileProtectedStorage,
  loadProtectedInstallationId,
} from './native-protected-storage.ts'
import { mobileSystemBrowser } from './system-browser.ts'
import { loadMobilePlatformEnvironment } from './platform-environment.ts'
import { MobileCompanionProjectionCacheRuntime } from './companion-cache-runtime.ts'
import './root.css'

const environment = loadMobilePlatformEnvironment(import.meta.env)
let companionVisibilityDisposer: (() => Promise<void>) | undefined
let companionDeepLinkBinding: MobilePairingDeepLinkBinding | undefined
let companionAccountDisposer: (() => void) | undefined
let companionSurface: MobileCompanionSurface | undefined

/**
 * Remove the process-lifetime visibility listeners bound by the Mobile entry.
 * @returns settled after document listeners and a pending Capacitor handle are removed.
 */
export function disposeCompanionVisibility(): Promise<void> {
  return Promise.all([
    companionVisibilityDisposer?.() ?? Promise.resolve(),
    companionDeepLinkBinding?.dispose() ?? Promise.resolve(),
    Promise.resolve(companionAccountDisposer?.()),
  ]).then(() => undefined)
}

/** Settles after the native Installation presentation is bound and the Mobile product surface mounts. */
export const mobileProductStarted = mountMobileProduct()

async function mountMobileProduct(): Promise<void> {
  const protectedStorage = new CapacitorMobileProtectedStorage()
  const parsedInstallationId = parseInstallationId(await loadProtectedInstallationId(
    protectedStorage,
    environment.identityNamespace,
  ))
  const presentation = mobileInstallationPresentation(await Device.getInfo())
  const installation = new PlatformAccountInstallation({
    environment,
    installationId: parsedInstallationId,
    installationKind: 'mobile',
    presentation,
    transport: new PlatformAccountHttpTransport({ environment }),
    store: new IndexedDbInstallationAccountStore(`deepseek-gestalt-platform-account:${environment.databaseIdentity}`),
    systemBrowser: mobileSystemBrowser,
  })

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
  let companionChannel: MobileSnowCompanionProductChannel | undefined
  let companionConnectionChannel: MobileCompanionConnectionChannel | undefined
  if (environment.environment === 'production') {
    const relayUrl = requiredWss(import.meta.env.VITE_REMOTE_RELAY_WSS_URL)
    const inboundMaxBytes = positiveInteger(import.meta.env.VITE_REMOTE_RELAY_INBOUND_MAX_BYTES, 'inbound bytes')
    const inboundMaxMessages = positiveInteger(import.meta.env.VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES, 'inbound messages')
    if (inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
      throw new TypeError('Mobile Relay inbound bytes must admit one maximum Relay message')
    }
    const handshake = new SnowMobileHandshakeClient()
    const attachmentKeys = new PairingCompanionKeyVault(new NativeMobilePairingStateStore(
      protectedStorage,
      environment.databaseIdentity,
    ))
    let attachmentOwner: SnowMobileAttachmentOwner | undefined
    let channel: SnowCompanionProtocolChannel | undefined
    let receiver: MobileNoiseCompanionReceiver | undefined
    let projectionCache: MobileCompanionProjectionCacheRuntime | undefined
    let projectionOwner: string | undefined
    const productConnection = new MobileSnowCompanionConnection()
    let connectionGeneration: number | undefined
    let activeSourceAttachmentId: ReturnType<typeof parseRelayAttachmentId> | undefined
    let pendingGeneration: number | undefined
    let pendingPairingSelector: RelayPairingSelector | undefined
    const clearNoiseConnection = (): void => {
      productConnection.disconnect()
      attachmentOwner?.dispose()
      attachmentOwner = undefined
      channel?.dispose()
      channel = undefined
      receiver = undefined
      connectionGeneration = undefined
      activeSourceAttachmentId = undefined
      pendingGeneration = undefined
      pendingPairingSelector = undefined
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
          clearNoiseConnection()
          companionRuntime()?.invalidateAuthenticatedPeer()
          if (ready.peers.length > 1) throw new Error('Mobile Relay has multiple Desktop pairing peers')
          return
        }
        if (peer.generation === connectionGeneration || peer.generation === pendingGeneration) return
        clearNoiseConnection()
        companionRuntime()?.invalidateAuthenticatedPeer()
        const reconnectState = attachmentKeys.reconnectState(parsePersonalPairingId(peer.pairingSelector))
        if (reconnectState === undefined) throw new Error('Mobile Relay peer has no retained Snow pairing state')
        pendingGeneration = peer.generation
        pendingPairingSelector = peer.pairingSelector
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
        if (pendingPairingSelector === undefined) throw new Error('Mobile Relay ciphertext has no pairing selector')
        const pairingSelector = pendingPairingSelector
        const nextChannel = attachmentOwner.finish(ciphertext, sourceAttachmentId)
        attachmentOwner.dispose()
        channel?.dispose()
        channel = nextChannel
        connectionGeneration = pendingGeneration
        pendingGeneration = undefined
        pendingPairingSelector = undefined
        activeSourceAttachmentId = sourceAttachmentId
        attachmentOwner = undefined
        productConnection.connect({
          channel,
          targetAttachmentId: sourceAttachmentId,
          pairingSelector,
          generation: connectionGeneration,
        })
        companionRuntime()?.markAuthenticatedPeer()
        const accountSnapshot = installation.getSnapshot()
        if (accountSnapshot.status !== 'signed-in' || accountSnapshot.account === undefined) {
          throw new Error('Mobile Companion cache requires the signed-in Platform Account')
        }
        const projectionCache = new MobileCompanionProjectionCacheRuntime({
          environment: environment.environment,
          accountId: accountSnapshot.account.id,
          pairingId: parsePersonalPairingId(pairingSelector),
          keys: attachmentKeys,
        })
        selectProjectionCache(
          `${accountSnapshot.account.id}\0${pairingSelector}`,
          projectionCache,
        )
        void companionSurface?.restoreProjectionCache().catch((error: unknown) => {
          console.error('[companion-cache] offline projection restore failed:', error)
        })
        receiver = new MobileNoiseCompanionReceiver(
          channel,
          connectionGeneration,
          companion,
          () => ({
            acceptValidatedCompanionResult: (result) => {
              companionChannel?.acceptResult(result)
              companionSurface?.bindValidatedCompanionResults()?.acceptValidatedCompanionResult(result)
            },
          }),
          () => companionConnectionChannel === undefined
            ? undefined
            : companionSurface?.bindAuthenticatedConnection(companionConnectionChannel),
          (offset) => {
            const submission = companionChannel?.refreshSurface(offset)
            if (submission !== undefined) companionSurface?.trackSurfaceRefresh(submission)
          },
          () => {
            void companionChannel?.reconcileUnknown().catch((error: unknown) => {
              console.error('[mobile-companion] operation reconciliation failed:', error)
            })
          },
        )
      },
      onConnectionReady: () => { companionRuntime()?.markConnectionOpen() },
      onConnectionLost: () => { clearNoiseConnection(); companionRuntime()?.forgetConnection() },
      onTransportError: () => { clearNoiseConnection(); companionRuntime()?.forgetConnection() },
    })
    companion = new CompanionForegroundRuntime({ relay })
    installCompanionRuntime(companion)
    companionVisibilityDisposer = bindCompanionProcessVisibility(companion)
    const productChannel = new MobileSnowCompanionProductChannel({
      runtime: companion,
      connection: productConnection,
      installation,
      attachmentKeys,
      platformOrigin: environment.origin,
      sendCiphertext: async (targetAttachmentId, ciphertext) => {
        await relay.sendCiphertext(targetAttachmentId, ciphertext)
      },
      reportFailure: (error) => { console.error('[mobile-companion] encrypted operation failed:', error) },
      trackHistoryRefresh: (sessionId, submission) => {
        companionSurface?.trackHistoryRefresh(sessionId, submission)
      },
      trackSurfaceRefresh: (submission) => { companionSurface?.trackSurfaceRefresh(submission) },
      recoveredResult: (result) => {
        companionSurface?.bindValidatedCompanionResults()?.acceptValidatedCompanionResult(result)
      },
    })
    companionChannel = productChannel
    companionConnectionChannel = {
      mutations: productChannel,
      content: {
        loadImage: async (sessionId, attachment) => await productChannel.loadImage(sessionId, attachment),
      },
    }
    const pairingController = new MobilePairingController({
      installation,
      transport: new RemoteAccessHttpTransport({ environment }),
      handshake,
      attachmentKeys,
      scanner: new NativeMobilePairingQrScanner(),
      relay: companion,
      companion,
    })
    const selectProjectionCache = (
      owner: string,
      cache: MobileCompanionProjectionCacheRuntime,
    ): void => {
      if (projectionOwner === owner) return
      projectionOwner = owner
      projectionCache = cache
      companionSurface?.setProjectionCache(cache)
      productChannel.setOperationSettlement(cache.operationSettlement)
    }
    const releaseProjectionAuthority = async (deleteStored: boolean): Promise<void> => {
      if (projectionOwner === undefined && projectionCache === undefined) return
      projectionOwner = undefined
      projectionCache = undefined
      productChannel.setOperationSettlement(undefined)
      companionRuntime()?.invalidateAuthenticatedPeer()
      await companionSurface?.releaseProjectionCache(deleteStored)
    }
    const installRetainedProjectionCache = async (): Promise<void> => {
      const accountSnapshot = installation.getSnapshot()
      const grant = attachmentKeys.relayAuthority()
      if (accountSnapshot.status !== 'signed-in' || accountSnapshot.account === undefined
        || grant?.pairingSelector === undefined || companionSurface === undefined) {
        await releaseProjectionAuthority(false)
        return
      }
      const cache = new MobileCompanionProjectionCacheRuntime({
        environment: environment.environment,
        accountId: accountSnapshot.account.id,
        pairingId: parsePersonalPairingId(grant.pairingSelector),
        keys: attachmentKeys,
      })
      selectProjectionCache(`${accountSnapshot.account.id}\0${grant.pairingSelector}`, cache)
      await companionSurface.restoreProjectionCache()
    }
    pairingController.subscribe(() => {
      if (pairingController.getSnapshot().status === 'paired') {
        void installRetainedProjectionCache().catch((error: unknown) => {
          console.error('[companion-cache] paired projection restore failed:', error)
        })
      }
    })
    pairing = {
      getSnapshot: () => pairingController.getSnapshot(),
      subscribe: listener => pairingController.subscribe(listener),
      completeLink: async (link) => { await pairingController.completeLink(link) },
      scanQr: async (video, signal) => { await pairingController.scanQr(video, signal) },
      retryPairing: async () => { await pairingController.retryPairing() },
      activate: async () => {
        await pairingController.activate()
        await installRetainedProjectionCache()
        companionDeepLinkBinding?.setReady(true)
      },
      deactivate: async () => {
        companionDeepLinkBinding?.setReady(false)
        await releaseProjectionAuthority(false)
        await pairingController.deactivate()
      },
      unpair: async () => {
        await releaseProjectionAuthority(true)
        await pairingController.unpair()
      },
    }
    companionDeepLinkBinding = bindMobilePairingDeepLinks(
      async (link) => { await pairing.completeLink(link) },
      { onError: (error) => { console.error('[mobile-companion] pairing deep link failed:', error) } },
    )
    let selectedAccountId: string | undefined
    companionAccountDisposer = installation.subscribe(() => {
      const snapshot = installation.getSnapshot()
      const accountId = snapshot.status === 'signed-in' ? snapshot.account?.id : undefined
      if (accountId === selectedAccountId) return
      selectedAccountId = accountId
      companionDeepLinkBinding?.setReady(false)
      void releaseProjectionAuthority(false).catch((error: unknown) => {
        console.error('[companion-cache] Account authority release failed:', error)
      })
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
  const mounted = mountMobileEntry(root, {
    installation,
    pairing,
    companion,
  })
  companionSurface = mounted.companionSurface
}
