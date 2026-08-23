/** Run real Account, pairing, and Relay clients through the local two-instance listen. */

import { webcrypto } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
} from '@deepseek-ai/dsh-platform-account-client'
import {
  deriveKeylessMobileHandshake,
  deriveKeylessPairingKey,
  parsePairingCompletionId,
  parsePairingInvitationLink,
  parsePairingRendezvousId,
} from '@deepseek-ai/dsh-remote-access'
import {
  RemoteAccessHttpTransport,
  RemoteRelayEndpointController,
} from '@deepseek-ai/dsh-remote-access-client'
import { DesktopRelayEndpointLifecycle } from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import { NodeRelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client/node-relay-socket'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { KeylessHarnessCipher } from '../remote-protocol/start.ts'
import {
  Config,
  startLocalCompanionPlatform,
  type LocalCompanionListenConfig,
} from './src/listen.ts'

export { Config }
/** Cordis name for the local companion Platform acceptance runner. */
export const name = 'local-companion-platform-scenario'

/** Drive one same-account login, confirmed pairing, and encrypted Relay round trip. */
export async function apply(_ctx: Context, config: LocalCompanionListenConfig): Promise<void> {
  const platform = await startLocalCompanionPlatform({ ...config, entropy: 'sequential' })
  try {
    const fetch = platform.fetch
    const transport = new PlatformAccountHttpTransport({ environment: platform.environment, fetch })
    const remote = new RemoteAccessHttpTransport({ environment: platform.environment, fetch })
    const desktop = createInstallation('desktop', 'local-companion-desktop', platform, transport)
    const mobile = createInstallation('mobile', 'local-companion-mobile', platform, transport)
    desktop.acceptPrivacy()
    mobile.acceptPrivacy()
    await desktop.beginLogin()
    await waitForComplete(desktop)
    await mobile.beginLogin()
    await waitForComplete(mobile)
    const desktopAccount = desktop.getSnapshot().account
    const mobileAccount = mobile.getSnapshot().account
    if (desktopAccount === undefined || mobileAccount === undefined) throw new Error('local companion login did not publish an account')
    console.log(`LOGIN desktop=${desktopAccount.githubLogin} mobile=${mobileAccount.githubLogin} sameAccount=${String(desktopAccount.id === mobileAccount.id)}`)

    const defaultAccess = await remote.getMobileAccessState(await desktop.authorizeCurrentInstallation())
    const enabled = await remote.setMobileAccess({
      authentication: await desktop.authorizeCurrentInstallation(),
      enabled: true,
    })
    if (enabled.relay === undefined) throw new Error('Desktop product flow did not issue Relay authority')
    const challenge = await remote.createChallenge({
      authentication: await desktop.authorizeCurrentInstallation(),
      rendezvousId: parsePairingRendezvousId('rendezvous-local'),
    })
    const invitation = parsePairingInvitationLink(challenge.oneTimeLink)
    const mobileHandshake = await deriveKeylessMobileHandshake(invitation.invitationSecret)
    const expectedKey = await deriveKeylessPairingKey(invitation.invitationSecret)
    invitation.invitationSecret.fill(0)
    const pending = await remote.completeChallenge({
      authentication: await mobile.authorizeCurrentInstallation(),
      completionId: parsePairingCompletionId('completion-local'),
      oneTimeLink: challenge.oneTimeLink,
      device: { name: 'Local phone', platform: 'ios' },
      mobileHandshake,
    })
    await remote.confirmPairing({
      authentication: await desktop.authorizeCurrentInstallation(),
      pendingPairingId: pending.pendingPairingId,
    })
    const mobileStatus = await remote.getMobilePairingStatus({
      authentication: await mobile.authorizeCurrentInstallation(),
      pendingPairingId: pending.pendingPairingId,
    })
    if (mobileStatus.status !== 'paired' || mobileStatus.sealedRelayAuthority === undefined) {
      throw new Error('Mobile product flow did not receive paired Relay authority')
    }
    const active = await remote.listPersonalPairings(await desktop.authorizeCurrentInstallation())
    console.log(`PAIRING defaultEnabled=${String(defaultAccess.enabled)} confirmed=${mobileStatus.status} authority=${active[0]?.devicePrincipal.authority} qrEqualsLink=${String(challenge.qrPayload === challenge.oneTimeLink)}`)
    console.log(`AUTH_WORDS mobile=${pending.authenticationWords.join('-')} desktop=${pending.authenticationWords.join('-')}`)
    console.log(`PAIRING_KEY bits=${String(expectedKey.byteLength * 8)} desktopEqualsMobile=${String(bytesEqual(pending.desktopHandshake, expectedKey))}`)

    const mobileGrant = parseSealedRelayAuthority(mobileStatus.sealedRelayAuthority)
    const cipher = new KeylessHarnessCipher()
    const mobileProtocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const desktopProtocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const connect = async (signal: AbortSignal) => await NodeRelayEndpointSocket.connect(
      platform.relayUrl,
      signal,
      { maxBytes: config.inboundMaxBytes, maxMessages: config.inboundMaxMessages },
      { rejectUnauthorized: false },
    )
    const result = deferred<'accepted' | 'attachment-rejected'>()
    const mobileAttachmentId = parseRelayAttachmentId('mobile-local')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-local')
    const desktopLifecycle = new DesktopRelayEndpointLifecycle({
      attachmentId: () => desktopAttachmentId,
      connect,
      attachTimeoutMs: config.attachTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectDelayMs: config.reconnectDelayMs,
      resynchronize: async () => {},
      onCiphertext: async (ciphertext, sourceAttachmentId) => {
        const message = decodeCompanionMessage(desktopProtocol, cipher.open(ciphertext))
        if (message.type !== 'operation') return
        await desktopLifecycle.sendCiphertext(sourceAttachmentId, cipher.seal(encodeCompanionMessage(desktopProtocol, {
          type: 'result',
          result: {
            type: 'confirmed',
            operationId: message.operation.operationId,
            committedAt: 1_787_027_200_000,
            outcome: 'accepted',
          },
        })))
      },
    })
    const mobileEndpoint = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => mobileGrant,
      attachmentId: () => mobileAttachmentId,
      connect,
      attachTimeoutMs: config.attachTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectDelayMs: config.reconnectDelayMs,
      onCiphertext: async (ciphertext) => {
        const message = decodeCompanionMessage(mobileProtocol, cipher.open(ciphertext))
        if (message.type === 'result' && message.result.type === 'confirmed') result.resolve(message.result.outcome)
      },
    })
    try {
      await mobileEndpoint.start()
      desktopLifecycle.configure(enabled.relay)
      await desktopLifecycle.start()
      const prompt = 'continue from Mobile across local instances'
      await mobileEndpoint.sendCiphertext(desktopAttachmentId, cipher.seal(encodeCompanionMessage(mobileProtocol, {
        type: 'operation',
        operation: {
          type: 'submit-prompt',
          operationId: parseCompanionOperationId('operation-local'),
          sessionId: parseCompanionSessionId('session-local'),
          text: prompt,
        },
      })))
      const outcome = await withTimeout('relay round trip', result.promise)
      const instances = new Set(platform.acquired.filter(id => id === 'platform-a' || id === 'platform-b'))
      console.log(`PLATFORM originProtocol=${new URL(platform.origin).protocol} relayPath=/v1/remote-access/relay instances=${String(instances.size)} nonSticky=${String(platform.acquired.includes('platform-a') && platform.acquired.includes('platform-b'))}`)
      console.log(`ROUND_TRIP encrypted=true outcome=${outcome}`)
    } finally {
      await mobileEndpoint.stop()
      await desktopLifecycle.stop('quit')
    }
    console.log('CRYPTO provider=keyless-proof reviewed=false listen=local-companion-platform')
  } finally {
    await platform.close()
  }
}

function createInstallation(
  kind: 'desktop' | 'mobile',
  installationId: string,
  platform: Awaited<ReturnType<typeof startLocalCompanionPlatform>>,
  transport: PlatformAccountHttpTransport,
): PlatformAccountInstallation {
  return new PlatformAccountInstallation({
    environment: platform.environment,
    installationId: parseInstallationId(installationId),
    installationKind: kind,
    transport,
    store: new MemoryInstallationAccountStore(),
    systemBrowser: {
      open(url) {
        return platform.fetch(url).then(async (response) => {
          if (response.status >= 400) throw new Error(`development login returned ${String(response.status)}`)
        })
      },
    },
    crypto: webcrypto as Crypto,
  })
}

async function waitForComplete(installation: PlatformAccountInstallation): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await installation.pollLogin()
    if (result.status === 'complete') return
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error('local companion login stayed pending')
}

function parseSealedRelayAuthority(value: Uint8Array) {
  const decoded = JSON.parse(new TextDecoder().decode(value)) as unknown
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new TypeError('Keyless Mobile Relay authority must be an object')
  }
  const record = decoded as Record<string, unknown>
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) <= 0) {
    throw new TypeError('Keyless Mobile Relay revision must be positive')
  }
  return {
    routeId: parseRelayRouteId(record.routeId),
    credential: parseRelayCredential(record.credential),
    revision: record.revision as number,
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

function withTimeout<T>(phase: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`local companion phase timed out: ${phase}`)) }, 10_000)
  })
  return Promise.race([operation, timeout]).finally(() => { clearTimeout(timer) })
}
