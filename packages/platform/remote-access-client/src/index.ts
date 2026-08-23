/** Authenticated browser/Host transport for the Remote Access public service. */

import {
  parseInstallationId,
  parsePlatformAccountId,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import type {
  MobileAccessState,
  MobilePairingStatus,
  EndpointPairingChallengeView,
  EndpointPairingConfirmation,
  EndpointPairingDesktopView,
  EndpointPairingMobileView,
  PairingAccountAuthentication,
  PairingChallengeId,
  PairingChallengeView,
  PairingCompletionId,
  PairingCompletionView,
  PairingDeviceDescription,
  PairingRendezvousId,
  PendingPairingId,
  PersonalPairingId,
  PersonalPairingView,
  RelayCredentialGrant,
  RemoteAccessErrorCode,
} from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

export * from './relay.ts'
export * from './browser-relay-socket.ts'
export * from './relay-queue.ts'
export * from './mobile-relay-lifecycle.ts'
export * from './development-keyless-companion.ts'
import {
  PERSONAL_PAIRING_PROTOCOL_MAJOR,
  RemoteAccessError,
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'

/** Remote Access operations consumed by Desktop Settings and the signed-in Mobile flow. */
export interface RemoteAccessTransport {
  /** @param authentication - current Desktop authorization. @returns current Mobile Access state. */
  getMobileAccessState(authentication: PairingAccountAuthentication): Promise<MobileAccessState>
  /** @param input - current Desktop authorization and requested state. @returns committed state. */
  setMobileAccess(input: { authentication: PairingAccountAuthentication; enabled: boolean }): Promise<MobileAccessState>
  /** @param authentication - current Desktop authorization. @returns fresh Desktop-only Relay authority. */
  reissueDesktopRelayAuthority(authentication: PairingAccountAuthentication): Promise<MobileAccessState>
  /** @param input - current Desktop authorization and rendezvous id. @returns single-use challenge. */
  createChallenge(input: {
    authentication: PairingAccountAuthentication
    rendezvousId: PairingRendezvousId
  }): Promise<PairingChallengeView>
  /** @param input - Desktop authorization and invitation routing metadata. @returns allocated opaque route. */
  createEndpointChallenge(input: {
    authentication: PairingAccountAuthentication
    rendezvousId: PairingRendezvousId
    expiresAt: number
  }): Promise<EndpointPairingChallengeView>
  /** Cancel one unused endpoint-owned invitation. */
  cancelEndpointChallenge(input: {
    authentication: PairingAccountAuthentication
    challengeId: PairingChallengeId
  }): Promise<void>
  /** @param authentication - current Desktop authorization. @returns endpoint-owned pairing work. */
  listEndpointPending(authentication: PairingAccountAuthentication): Promise<readonly EndpointPairingDesktopView[]>
  /** @param input - Desktop authorization, pending identity, and local Snow message 2. */
  submitEndpointMessage2(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    message2: Uint8Array
  }): Promise<void>
  /** @param input - Desktop authorization and locally authenticated pending identity. */
  confirmEndpointPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    desktopCredentialDigest: Uint8Array
    mobileCredentialDigest: Uint8Array
  }): Promise<EndpointPairingConfirmation>
  /** Reject one endpoint-owned pending handshake. */
  rejectEndpointPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<void>
  /** @param input - Desktop authorization and locally sealed Mobile Relay authority. */
  deliverEndpointRelayAuthority(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    sealedRelayAuthority: Uint8Array
  }): Promise<void>
  /** @param input - current Desktop authorization and challenge id. */
  cancelChallenge(input: {
    authentication: PairingAccountAuthentication
    challengeId: PairingChallengeId
  }): Promise<void>
  /** @param authentication - current Desktop authorization. @returns Desktop-owned pending pairings. */
  listPendingPairings(authentication: PairingAccountAuthentication): Promise<readonly PairingCompletionView[]>
  /** @param authentication - current Desktop authorization. @returns Desktop-owned active pairings. */
  listPersonalPairings(authentication: PairingAccountAuthentication): Promise<readonly PersonalPairingView[]>
  /** @param input - current Desktop authorization and pairing id. */
  revokePersonalPairing(input: {
    authentication: PairingAccountAuthentication
    pairingId: PersonalPairingId
  }): Promise<void>
  /** @param input - current Desktop authorization and pending id. @returns activated pairing. */
  confirmPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<PersonalPairingView>
  /** @param input - current Desktop authorization and pending id. */
  rejectPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<void>
  /** @param input - current Mobile authorization, invitation, device, and handshake. @returns pending pairing. */
  completeChallenge(input: {
    authentication: PairingAccountAuthentication
    completionId: PairingCompletionId
    oneTimeLink: string
    device: PairingDeviceDescription
    mobileHandshake: Uint8Array
  }): Promise<PairingCompletionView>
  /** @param input - Mobile authorization and local Snow message 1. @returns stable pending identity. */
  submitEndpointMessage1(input: {
    authentication: PairingAccountAuthentication
    challengeId: PairingChallengeId
    completionId: PairingCompletionId
    device: PairingDeviceDescription
    message1: Uint8Array
  }): Promise<{ pendingPairingId: PendingPairingId }>
  /** @param input - Mobile authorization and completion identity. @returns current endpoint mailbox stage. */
  getEndpointPairingStatus(input: {
    authentication: PairingAccountAuthentication
    completionId: PairingCompletionId
  }): Promise<EndpointPairingMobileView>
  /** @param input - Mobile authorization, completion identity, and local Snow message 3. */
  submitEndpointMessage3(input: {
    authentication: PairingAccountAuthentication
    completionId: PairingCompletionId
    message3: Uint8Array
  }): Promise<void>
  /** @param input - fresh Mobile authorization, pending id, and message 3. @returns finished pending pairing. */
  finishChallenge(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    mobileFinish: Uint8Array
  }): Promise<PairingCompletionView>
  /** @param input - current Mobile authorization and pending id. @returns Desktop decision state. */
  getMobilePairingStatus(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<MobilePairingStatus>
}

/** HTTP transport construction inputs. */
export interface RemoteAccessHttpTransportOptions {
  environment: SelectedPlatformEnvironment
  fetch?: typeof fetch
}

/** Fixed authenticated Remote Access HTTP endpoint shared by Desktop and Mobile. */
export class RemoteAccessHttpTransport implements RemoteAccessTransport {
  private readonly fetch: typeof fetch
  private readonly endpoint: string

  /** @param options - selected Platform deployment and optional Fetch implementation. */
  constructor(options: RemoteAccessHttpTransportOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.endpoint = `${options.environment.origin}/v1/remote-access/personal-pairing`
  }

  async getMobileAccessState(authentication: PairingAccountAuthentication): Promise<MobileAccessState> {
    return parseMobileAccess(await this.call(authentication, { operation: 'get-mobile-access' }))
  }

  async setMobileAccess(input: {
    authentication: PairingAccountAuthentication
    enabled: boolean
  }): Promise<MobileAccessState> {
    return parseMobileAccess(await this.call(input.authentication, {
      operation: 'set-mobile-access', enabled: input.enabled,
    }))
  }

  async reissueDesktopRelayAuthority(authentication: PairingAccountAuthentication): Promise<MobileAccessState> {
    return parseMobileAccess(await this.call(authentication, { operation: 'reissue-desktop-relay' }))
  }

  async createChallenge(input: {
    authentication: PairingAccountAuthentication
    rendezvousId: PairingRendezvousId
  }): Promise<PairingChallengeView> {
    return parseChallenge(await this.call(input.authentication, {
      operation: 'create-challenge', rendezvousId: input.rendezvousId,
    }))
  }

  async createEndpointChallenge(input: {
    authentication: PairingAccountAuthentication
    rendezvousId: PairingRendezvousId
    expiresAt: number
  }): Promise<EndpointPairingChallengeView> {
    return parseEndpointChallenge(await this.call(input.authentication, {
      operation: 'create-endpoint-challenge',
      rendezvousId: input.rendezvousId,
      expiresAt: input.expiresAt,
    }))
  }

  async cancelEndpointChallenge(input: {
    authentication: PairingAccountAuthentication
    challengeId: PairingChallengeId
  }): Promise<void> {
    await this.call(input.authentication, {
      operation: 'cancel-endpoint-challenge', challengeId: input.challengeId,
    })
  }

  async listEndpointPending(authentication: PairingAccountAuthentication): Promise<readonly EndpointPairingDesktopView[]> {
    return parseArray(await this.call(authentication, { operation: 'list-endpoint-pending' }), parseEndpointDesktop)
  }

  async submitEndpointMessage2(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    message2: Uint8Array
  }): Promise<void> {
    await this.call(input.authentication, {
      operation: 'submit-endpoint-message2', pendingPairingId: input.pendingPairingId,
      message2: encodeBytes(input.message2),
    })
  }

  async confirmEndpointPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    desktopCredentialDigest: Uint8Array
    mobileCredentialDigest: Uint8Array
  }): Promise<EndpointPairingConfirmation> {
    return parseEndpointConfirmation(await this.call(input.authentication, {
      operation: 'confirm-endpoint-pairing', pendingPairingId: input.pendingPairingId,
      desktopCredentialDigest: encodeBytes(input.desktopCredentialDigest),
      mobileCredentialDigest: encodeBytes(input.mobileCredentialDigest),
    }))
  }

  async rejectEndpointPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<void> {
    await this.call(input.authentication, {
      operation: 'reject-endpoint-pairing', pendingPairingId: input.pendingPairingId,
    })
  }

  async deliverEndpointRelayAuthority(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    sealedRelayAuthority: Uint8Array
  }): Promise<void> {
    await this.call(input.authentication, {
      operation: 'deliver-endpoint-relay-authority', pendingPairingId: input.pendingPairingId,
      sealedRelayAuthority: encodeBytes(input.sealedRelayAuthority),
    })
  }

  async cancelChallenge(input: {
    authentication: PairingAccountAuthentication
    challengeId: PairingChallengeId
  }): Promise<void> {
    await this.call(input.authentication, { operation: 'cancel-challenge', challengeId: input.challengeId })
  }

  async listPendingPairings(authentication: PairingAccountAuthentication): Promise<readonly PairingCompletionView[]> {
    return parseArray(await this.call(authentication, { operation: 'list-pending' }), parseCompletion)
  }

  async listPersonalPairings(authentication: PairingAccountAuthentication): Promise<readonly PersonalPairingView[]> {
    return parseArray(await this.call(authentication, { operation: 'list-pairings' }), parsePairing)
  }

  async revokePersonalPairing(input: {
    authentication: PairingAccountAuthentication
    pairingId: PersonalPairingId
  }): Promise<void> {
    await this.call(input.authentication, { operation: 'revoke-pairing', pairingId: input.pairingId })
  }

  async confirmPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<PersonalPairingView> {
    return parsePairing(await this.call(input.authentication, {
      operation: 'confirm-pairing', pendingPairingId: input.pendingPairingId,
    }))
  }

  async rejectPairing(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<void> {
    await this.call(input.authentication, { operation: 'reject-pairing', pendingPairingId: input.pendingPairingId })
  }

  async completeChallenge(input: {
    authentication: PairingAccountAuthentication
    completionId: PairingCompletionId
    oneTimeLink: string
    device: PairingDeviceDescription
    mobileHandshake: Uint8Array
  }): Promise<PairingCompletionView> {
    return parseCompletion(await this.call(input.authentication, {
      operation: 'complete-challenge',
      completionId: input.completionId,
      oneTimeLink: input.oneTimeLink,
      device: input.device,
      mobileHandshake: encodeBytes(input.mobileHandshake),
    }))
  }

  async submitEndpointMessage1(input: {
    authentication: PairingAccountAuthentication
    challengeId: PairingChallengeId
    completionId: PairingCompletionId
    device: PairingDeviceDescription
    message1: Uint8Array
  }): Promise<{ pendingPairingId: PendingPairingId }> {
    const value = requiredRecord(await this.call(input.authentication, {
      operation: 'submit-endpoint-message1', challengeId: input.challengeId,
      completionId: input.completionId, device: input.device, message1: encodeBytes(input.message1),
    }), 'Endpoint Pairing message 1 response')
    return { pendingPairingId: parsePendingPairingId(value.pendingPairingId) }
  }

  async getEndpointPairingStatus(input: {
    authentication: PairingAccountAuthentication
    completionId: PairingCompletionId
  }): Promise<EndpointPairingMobileView> {
    return parseEndpointMobile(await this.call(input.authentication, {
      operation: 'get-endpoint-pairing-status', completionId: input.completionId,
    }))
  }

  async submitEndpointMessage3(input: {
    authentication: PairingAccountAuthentication
    completionId: PairingCompletionId
    message3: Uint8Array
  }): Promise<void> {
    await this.call(input.authentication, {
      operation: 'submit-endpoint-message3', completionId: input.completionId,
      message3: encodeBytes(input.message3),
    })
  }

  async finishChallenge(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
    mobileFinish: Uint8Array
  }): Promise<PairingCompletionView> {
    return parseCompletion(await this.call(input.authentication, {
      operation: 'finish-challenge',
      pendingPairingId: input.pendingPairingId,
      mobileFinish: encodeBytes(input.mobileFinish),
    }))
  }

  async getMobilePairingStatus(input: {
    authentication: PairingAccountAuthentication
    pendingPairingId: PendingPairingId
  }): Promise<MobilePairingStatus> {
    return parseMobilePairingStatus(await this.call(input.authentication, {
      operation: 'get-mobile-pairing-status',
      pendingPairingId: input.pendingPairingId,
    }))
  }

  private async call(authentication: PairingAccountAuthentication, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${authentication.accessToken}`,
        'X-Gestalt-Proof-Jti': authentication.proof.jti,
        'X-Gestalt-Proof-Issued-At': String(authentication.proof.issuedAt),
        'X-Gestalt-Proof-Signature': authentication.proof.signature,
      },
      body: JSON.stringify(body),
    })
    let value: unknown
    try {
      value = await response.json()
    } catch {
      if (response.ok) throw new TypeError('Remote Access response must be JSON')
    }
    if (response.ok) return value
    if (isRecord(value) && isRecord(value.error)
      && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
      const code = parseRemoteAccessErrorCode(value.error.code)
      const retryAfter = value.error.retryAfter
      if (code !== undefined) {
        throw new RemoteAccessError(
          code,
          value.error.message,
          Number.isSafeInteger(retryAfter) ? retryAfter as number : undefined,
        )
      }
    }
    throw new Error(`Remote Access request failed with HTTP ${response.status}`)
  }
}

function parseMobileAccess(value: unknown): MobileAccessState {
  const record = requiredRecord(value, 'Mobile Access response')
  if (typeof record.enabled !== 'boolean') throw new TypeError('Mobile Access enabled must be boolean')
  if (!record.enabled || record.relay === undefined) return { enabled: record.enabled }
  const relay = requiredRecord(record.relay, 'Mobile Access Relay grant')
  const grant: RelayCredentialGrant = {
    routeId: parseRelayRouteId(relay.routeId),
    endpoint: requiredEndpoint(relay.endpoint, 'Mobile Access Relay endpoint'),
    credential: parseRelayCredential(relay.credential),
    revision: requiredPositiveInteger(relay.revision, 'Mobile Access Relay revision'),
  }
  return { enabled: true, relay: grant }
}

function requiredEndpoint(value: unknown, name: string): 'mobile' | 'desktop' {
  if (value !== 'mobile' && value !== 'desktop') throw new TypeError(`${name} must be mobile or desktop`)
  return value
}

function parseMobilePairingStatus(value: unknown): MobilePairingStatus {
  const record = requiredRecord(value, 'Mobile Pairing status response')
  if (record.status === 'pending' || record.status === 'rejected') return { status: record.status }
  if (record.status === 'paired') {
    return {
      status: 'paired', pairingId: parsePersonalPairingId(record.pairingId),
      ...(record.sealedRelayAuthority === undefined
        ? {}
        : { sealedRelayAuthority: decodeBytes(record.sealedRelayAuthority, 'Mobile Pairing sealed Relay authority') }),
    }
  }
  throw new TypeError('Mobile Pairing status is invalid')
}

function parseChallenge(value: unknown): PairingChallengeView {
  const record = requiredRecord(value, 'Pairing Challenge response')
  const oneTimeLink = requiredString(record.oneTimeLink, 'Pairing Challenge oneTimeLink')
  const qrPayload = requiredString(record.qrPayload, 'Pairing Challenge qrPayload')
  if (qrPayload !== oneTimeLink) throw new TypeError('Pairing Challenge QR and link payloads must match')
  const expiresAt = requiredPositiveInteger(record.expiresAt, 'Pairing Challenge expiresAt')
  if (record.protocolMajor !== PERSONAL_PAIRING_PROTOCOL_MAJOR) throw new TypeError('Pairing Challenge protocol major is unsupported')
  return {
    challengeId: parsePairingChallengeId(record.challengeId),
    desktopFingerprint: requiredString(record.desktopFingerprint, 'Pairing Challenge desktopFingerprint'),
    ...(record.desktopStaticPublicKey === undefined
      ? {}
      : { desktopStaticPublicKey: decodeFixedBytes(record.desktopStaticPublicKey, 'Pairing Challenge Desktop public key', 32) }),
    rendezvousId: parsePairingRendezvousId(record.rendezvousId),
    expiresAt,
    protocolMajor: PERSONAL_PAIRING_PROTOCOL_MAJOR,
    oneTimeLink,
    qrPayload,
  }
}

function parseEndpointChallenge(value: unknown): EndpointPairingChallengeView {
  const record = requiredRecord(value, 'Endpoint Pairing challenge response')
  return {
    challengeId: parsePairingChallengeId(record.challengeId),
    expiresAt: requiredPositiveInteger(record.expiresAt, 'Endpoint Pairing challenge expiresAt'),
    routingLink: requiredString(record.routingLink, 'Endpoint Pairing challenge routingLink'),
  }
}

function parseEndpointDesktop(value: unknown): EndpointPairingDesktopView {
  const record = requiredRecord(value, 'Endpoint Pairing Desktop response')
  const pendingPairingId = parsePendingPairingId(record.pendingPairingId)
  const challengeId = parsePairingChallengeId(record.challengeId)
  const device = parseDevice(record.device)
  if (record.stage === 'confirmed') return { pendingPairingId, challengeId, stage: 'confirmed', device }
  const message1 = decodeBytes(record.message1, 'Endpoint Pairing message 1')
  if (record.stage === 'message1') return { pendingPairingId, challengeId, stage: 'message1', message1, device }
  if (record.stage === 'message3') return {
    pendingPairingId, challengeId, stage: 'message3', message1,
    message2: decodeBytes(record.message2, 'Endpoint Pairing message 2'),
    message3: decodeBytes(record.message3, 'Endpoint Pairing message 3'), device,
  }
  throw new TypeError('Endpoint Pairing Desktop stage is invalid')
}

function parseEndpointMobile(value: unknown): EndpointPairingMobileView {
  const record = requiredRecord(value, 'Endpoint Pairing Mobile response')
  const pendingPairingId = parsePendingPairingId(record.pendingPairingId)
  if (record.stage === 'awaiting-desktop' || record.stage === 'awaiting-authority') {
    return { stage: record.stage, pendingPairingId }
  }
  if (record.stage === 'rejected') return { stage: 'rejected', pendingPairingId }
  if (record.stage === 'message2') return {
    stage: 'message2', pendingPairingId,
    message2: decodeBytes(record.message2, 'Endpoint Pairing message 2'),
  }
  if (record.stage === 'confirmed') return {
    stage: 'confirmed', pendingPairingId,
    pairingId: parsePersonalPairingId(record.pairingId),
    sealedRelayAuthority: decodeBytes(record.sealedRelayAuthority, 'Endpoint Pairing sealed Relay authority'),
  }
  throw new TypeError('Endpoint Pairing Mobile stage is invalid')
}

function parseEndpointConfirmation(value: unknown): EndpointPairingConfirmation {
  const record = requiredRecord(value, 'Endpoint Pairing confirmation response')
  return {
    pairing: parsePairing(record.pairing),
    routeId: parseRelayRouteId(record.routeId),
    relayRevision: requiredPositiveInteger(record.relayRevision, 'Endpoint Pairing Relay revision'),
  }
}

function parseCompletion(value: unknown): PairingCompletionView {
  const record = requiredRecord(value, 'Pairing completion response')
  const words = record.authenticationWords
  if (!Array.isArray(words) || words.length !== 6 || words.some(word => typeof word !== 'string' || word === '')) {
    throw new TypeError('Pairing completion authenticationWords must contain six non-empty strings')
  }
  return {
    pendingPairingId: parsePendingPairingId(record.pendingPairingId),
    authenticationWords: words as [string, string, string, string, string, string],
    desktopHandshake: decodeBytes(record.desktopHandshake, 'Pairing completion desktopHandshake'),
    device: parseDevice(record.device),
  }
}

function parsePairing(value: unknown): PersonalPairingView {
  const record = requiredRecord(value, 'Personal Pairing response')
  const principal = requiredRecord(record.devicePrincipal, 'Device Principal')
  if (principal.authority !== 'companion-surface') throw new TypeError('Device Principal authority is invalid')
  return {
    id: parsePersonalPairingId(record.id),
    devicePrincipal: {
      id: parseDevicePrincipalId(principal.id),
      accountId: parsePlatformAccountId(principal.accountId),
      installationId: parseInstallationId(principal.installationId),
      authority: 'companion-surface',
    },
    device: parseDevice(record.device),
    pairedAt: requiredPositiveInteger(record.pairedAt, 'Personal Pairing pairedAt'),
    lastAccessAt: requiredPositiveInteger(record.lastAccessAt, 'Personal Pairing lastAccessAt'),
    online: requiredBoolean(record.online, 'Personal Pairing online'),
  }
}

function parseDevice(value: unknown): PairingDeviceDescription {
  const record = requiredRecord(value, 'Pairing device')
  const platform = record.platform
  if (platform !== 'ios' && platform !== 'android') throw new TypeError('Pairing device platform is invalid')
  return { name: requiredString(record.name, 'Pairing device name'), platform }
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new TypeError('Remote Access list response must be an array')
  return value.map(parse)
}

function encodeBytes(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBytes(value: unknown, name: string): Uint8Array {
  const encoded = requiredString(value, name)
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded) || encoded.length % 4 === 1) throw new TypeError(`${name} must be base64url`)
  const padded = encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4)
  const binary = atob(padded)
  const decoded = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (encodeBytes(decoded) !== encoded) throw new TypeError(`${name} must be canonical base64url`)
  return decoded
}

function decodeFixedBytes(value: unknown, name: string, length: number): Uint8Array {
  const bytes = decodeBytes(value, name)
  if (bytes.byteLength !== length) throw new TypeError(`${name} must contain ${String(length)} bytes`)
  return bytes
}

const REMOTE_ACCESS_ERROR_CODES: ReadonlySet<RemoteAccessErrorCode> = new Set([
  'MOBILE_ACCESS_DISABLED',
  'PAIRING_ACCOUNT_MISMATCH',
  'PAIRING_INSTALLATION_KIND_INVALID',
  'PAIRING_CHALLENGE_INVALID',
  'PAIRING_CHALLENGE_EXPIRED',
  'PAIRING_CHALLENGE_USED',
  'PAIRING_PENDING_INVALID',
  'PAIRING_ID_COLLISION',
  'PAIRING_RESOURCE_LIMIT',
  'QUOTA',
  'PLATFORM_CAPACITY',
])

function parseRemoteAccessErrorCode(value: string): RemoteAccessErrorCode | undefined {
  return REMOTE_ACCESS_ERROR_CODES.has(value as RemoteAccessErrorCode)
    ? value as RemoteAccessErrorCode
    : undefined
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be non-empty`)
  return value
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value as number
}
