/** HTTP Consumer for authenticated Remote Access Personal Pairing operations. */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseAccountProofJti, type AccountProof } from '@deepseek-ai/dsh-platform-account'
import {
  RemoteAccessError,
  parseAttachmentBlobReservationId,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  type PairingAccountAuthentication,
  type PairingCompletionView,
} from '@deepseek-ai/dsh-remote-access'
import {
  CorsOriginPolicy,
  HttpError,
  readJsonObject,
  writeHttpError,
  writeJson,
  writeRetryAfterError,
} from '@deepseek-ai/dsh-host-webserver'

const MAX_JSON_BYTES = 64 * 1024

/** HTTP Consumer configuration. */
export interface Config {
  /** Exact product origins allowed to call the route. */
  origins: string[]
}
/** Validated HTTP Consumer configuration. */
export const Config: z<Config> = z.object({ origins: z.array(z.string()).min(1).required() })
/** Cordis plugin name. */
export const name = 'remote-access-http'
/** Required Remote Access behavior and HTTP route registry. */
export const inject = ['remoteAccess', 'webServer']

/** Register the authenticated Personal Pairing route. */
export function apply(ctx: Context, config: Config): void {
  const origins = new CorsOriginPolicy(config.origins, 'Remote Access HTTP')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/v1/remote-access/personal-pairing',
    handler: async (req, res) => {
      try {
        if (handleCors(req, res, origins)) return
        if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Remote Access route requires POST')
        const authentication = pairingAuthenticationFromHeaders(req)
        const body = await readJsonObject(req, {
          maxBytes: MAX_JSON_BYTES,
          tooLarge: { status: 413, code: 'BODY_TOO_LARGE', message: 'Remote Access body is too large' },
          invalidJson: { status: 400, code: 'BODY_INVALID', message: 'Remote Access body must be JSON' },
          notObject: { status: 400, code: 'BODY_INVALID', message: 'Remote Access body must be an object' },
        })
        const result = await dispatch(ctx, authentication, body, () => requestClientIp(req))
        writeJson(res, 200, result)
      } catch (error) {
        answerError(res, error)
      }
    },
  }))
}

async function dispatch(
  ctx: Context,
  authentication: PairingAccountAuthentication,
  body: Record<string, unknown>,
  clientIp: () => string,
): Promise<unknown> {
  switch (requiredString(body.operation, 'operation')) {
    case 'get-mobile-access': return ctx.remoteAccess.getMobileAccessState(authentication)
    case 'set-mobile-access':
      return ctx.remoteAccess.setMobileAccess({ desktop: authentication, enabled: requiredBoolean(body.enabled, 'enabled') })
    case 'reissue-desktop-relay': return ctx.remoteAccess.reissueDesktopRelayAuthority(authentication)
    case 'create-challenge':
      return challengeWire(await ctx.remoteAccess.createChallenge({
        desktop: authentication,
        rendezvousId: parsePairingRendezvousId(body.rendezvousId),
        clientIp: clientIp(),
      }))
    case 'create-endpoint-challenge':
      requireExactKeys(body, ['operation', 'rendezvousId', 'expiresAt'], 'Endpoint Pairing challenge request')
      return endpointChallengeWire(await ctx.remoteAccess.createEndpointChallenge({
        desktop: authentication,
        rendezvousId: parsePairingRendezvousId(body.rendezvousId),
        clientIp: clientIp(),
        expiresAt: requiredPositiveSafeInteger(body.expiresAt, 'expiresAt'),
      }))
    case 'cancel-challenge':
      await ctx.remoteAccess.cancelChallenge({
        desktop: authentication,
        challengeId: parsePairingChallengeId(body.challengeId),
      })
      return { completed: true }
    case 'cancel-endpoint-challenge':
      await ctx.remoteAccess.cancelEndpointChallenge({
        desktop: authentication,
        challengeId: parsePairingChallengeId(body.challengeId),
      })
      return { completed: true }
    case 'list-pending': return (await ctx.remoteAccess.listPendingPairings(authentication)).map(completionWire)
    case 'list-endpoint-pending':
      return (await ctx.remoteAccess.listEndpointPending(authentication)).map(endpointDesktopWire)
    case 'list-pairings': return ctx.remoteAccess.listPersonalPairings(authentication)
    case 'revoke-pairing':
      await ctx.remoteAccess.revokePersonalPairing({
        desktop: authentication,
        pairingId: parsePersonalPairingId(body.pairingId),
      })
      return { completed: true }
    case 'revoke-mobile-pairing':
      await ctx.remoteAccess.revokeMobilePersonalPairing({
        mobile: authentication,
        pairingId: parsePersonalPairingId(body.pairingId),
      })
      return { completed: true }
    case 'get-mobile-pairing-status':
      return mobilePairingStatusWire(await ctx.remoteAccess.getMobilePairingStatus({
        mobile: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
      }))
    case 'confirm-pairing':
      return ctx.remoteAccess.confirmPairing({
        desktop: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
      })
    case 'confirm-endpoint-pairing':
      return ctx.remoteAccess.confirmEndpointPairing({
        desktop: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
        desktopCredentialDigest: decodeFixedBytes(body.desktopCredentialDigest, 'desktopCredentialDigest', 32),
        mobileCredentialDigest: decodeFixedBytes(body.mobileCredentialDigest, 'mobileCredentialDigest', 32),
      })
    case 'reject-endpoint-pairing':
      await ctx.remoteAccess.rejectEndpointPairing({
        desktop: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
      })
      return { completed: true }
    case 'submit-endpoint-message2':
      await ctx.remoteAccess.submitEndpointMessage2({
        desktop: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
        message2: decodeBytes(body.message2, 'message2'),
      })
      return { completed: true }
    case 'deliver-endpoint-relay-authority':
      await ctx.remoteAccess.deliverEndpointRelayAuthority({
        desktop: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
        sealedRelayAuthority: decodeBytes(body.sealedRelayAuthority, 'sealedRelayAuthority'),
      })
      return { completed: true }
    case 'reject-pairing':
      await ctx.remoteAccess.rejectPairing({
        desktop: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
      })
      return { completed: true }
    case 'complete-challenge':
      return completionWire(await ctx.remoteAccess.completeChallenge({
        mobile: authentication,
        completionId: parsePairingCompletionId(body.completionId),
        oneTimeLink: requiredString(body.oneTimeLink, 'oneTimeLink'),
        mobileHandshake: decodeBytes(body.mobileHandshake, 'mobileHandshake'),
      }))
    case 'submit-endpoint-message1':
      return ctx.remoteAccess.submitEndpointMessage1({
        mobile: authentication,
        challengeId: parsePairingChallengeId(body.challengeId),
        completionId: parsePairingCompletionId(body.completionId),
        message1: decodeBytes(body.message1, 'message1'),
      })
    case 'get-endpoint-pairing-status':
      return endpointMobileWire(await ctx.remoteAccess.getEndpointPairingStatus({
        mobile: authentication,
        completionId: parsePairingCompletionId(body.completionId),
      }))
    case 'submit-endpoint-message3':
      await ctx.remoteAccess.submitEndpointMessage3({
        mobile: authentication,
        completionId: parsePairingCompletionId(body.completionId),
        message3: decodeBytes(body.message3, 'message3'),
      })
      return { completed: true }
    case 'finish-challenge':
      return completionWire(await ctx.remoteAccess.finishChallenge({
        mobile: authentication,
        pendingPairingId: parsePendingPairingId(body.pendingPairingId),
        mobileFinish: decodeBytes(body.mobileFinish, 'mobileFinish'),
      }))
    case 'admit-blob':
      return ctx.remoteAccess.admitAttachmentBlob({
        owner: authentication,
        bytes: requiredNonNegativeSafeInteger(body.bytes, 'bytes'),
      })
    case 'release-blob':
      await ctx.remoteAccess.releaseAttachmentBlob({
        owner: authentication,
        reservationId: parseAttachmentBlobReservationId(requiredString(body.reservationId, 'reservationId')),
      })
      return { completed: true }
    default: throw new HttpError(400, 'OPERATION_INVALID', 'Remote Access operation is invalid')
  }
}

function endpointChallengeWire(value: Awaited<ReturnType<Context['remoteAccess']['createEndpointChallenge']>>): unknown {
  return value
}

function endpointDesktopWire(value: Awaited<ReturnType<Context['remoteAccess']['listEndpointPending']>>[number]): unknown {
  if (value.stage === 'confirmed') return value
  return {
    ...value,
    message1: encodeBytes(value.message1),
    ...(value.stage === 'message3'
      ? { message2: encodeBytes(value.message2), message3: encodeBytes(value.message3) }
      : {}),
  }
}

function endpointMobileWire(value: Awaited<ReturnType<Context['remoteAccess']['getEndpointPairingStatus']>>): unknown {
  if (value.stage === 'message2') return { ...value, message2: encodeBytes(value.message2) }
  if (value.stage === 'confirmed') return {
    ...value,
    sealedRelayAuthority: encodeBytes(value.sealedRelayAuthority),
  }
  return value
}

function completionWire(value: PairingCompletionView): unknown {
  return { ...value, desktopHandshake: encodeBytes(value.desktopHandshake) }
}

function challengeWire(value: Awaited<ReturnType<Context['remoteAccess']['createChallenge']>>): unknown {
  return {
    ...value,
    ...(value.desktopStaticPublicKey === undefined
      ? {}
      : { desktopStaticPublicKey: encodeBytes(value.desktopStaticPublicKey) }),
  }
}

function mobilePairingStatusWire(value: Awaited<ReturnType<Context['remoteAccess']['getMobilePairingStatus']>>): unknown {
  if (value.status !== 'paired' || value.sealedRelayAuthority === undefined) return value
  return { ...value, sealedRelayAuthority: encodeBytes(value.sealedRelayAuthority) }
}

/**
 * Parse current-Installation authentication from an HTTP request without assigning pairing scope.
 * @param input - untrusted HTTP headers.
 * @returns bearer and one-use proof for Platform Account verification.
 */
export function pairingAuthenticationFromHeaders(input: { headers: IncomingHttpHeaders }): PairingAccountAuthentication {
  const req = input
  return { accessToken: bearer(req), proof: proofHeaders(req) }
}

function bearer(req: { headers: IncomingHttpHeaders }): string {
  const value = req.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ') || value.length === 7) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Platform Account bearer token is required')
  }
  return value.slice(7)
}

function proofHeaders(req: { headers: IncomingHttpHeaders }): AccountProof {
  const jti = singleHeader(req, 'x-gestalt-proof-jti')
  const issuedAt = Number(singleHeader(req, 'x-gestalt-proof-issued-at'))
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new HttpError(400, 'PROOF_INVALID', 'Installation proof issuedAt is invalid')
  }
  return {
    jti: parseAccountProofJti(jti),
    issuedAt,
    signature: singleHeader(req, 'x-gestalt-proof-signature'),
  }
}

function singleHeader(req: { headers: IncomingHttpHeaders }, name: string): string {
  const value = req.headers[name]
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'PROOF_INVALID', `Missing ${name}`)
  return value
}

function handleCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: CorsOriginPolicy): boolean {
  const requestOrigin = req.headers.origin
  if (requestOrigin !== undefined) {
    const parsedOrigin = allowedOrigins.match(requestOrigin)
    if (parsedOrigin === undefined) {
      throw new HttpError(403, 'ORIGIN_DENIED', 'Remote Access request origin is not trusted')
    }
    res.setHeader('access-control-allow-origin', parsedOrigin)
    res.setHeader('vary', 'Origin')
  }
  if (req.method !== 'OPTIONS') return false
  res.writeHead(204, {
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-gestalt-proof-jti,x-gestalt-proof-issued-at,x-gestalt-proof-signature',
    'access-control-max-age': '600',
  })
  res.end()
  return true
}

function answerError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    writeHttpError(res, error)
    return
  }
  if (error instanceof RemoteAccessError) {
    writeRetryAfterError(
      res,
      error,
      error.code === 'QUOTA' || error.code === 'PLATFORM_CAPACITY' ? 429 : 409,
    )
    return
  }
  writeJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Remote Access request failed' } })
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'BODY_INVALID', `${name} must be non-empty`)
  return value
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'BODY_INVALID', `${name} must be boolean`)
  return value
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const expected = new Set(keys)
  if (Object.keys(record).length !== expected.size || Object.keys(record).some(key => !expected.has(key))) {
    throw new HttpError(400, 'BODY_INVALID', `${name} contains unsupported fields`)
  }
}

function requiredSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'BODY_INVALID', `${name} must be a safe integer`)
  }
  return value
}

function requiredNonNegativeSafeInteger(value: unknown, name: string): number {
  const integer = requiredSafeInteger(value, name)
  if (integer < 0) throw new HttpError(400, 'BODY_INVALID', `${name} must be a non-negative integer`)
  return integer
}

function requiredPositiveSafeInteger(value: unknown, name: string): number {
  const integer = requiredSafeInteger(value, name)
  if (integer <= 0) throw new HttpError(400, 'BODY_INVALID', `${name} must be a positive integer`)
  return integer
}

/** TCP peer address. Forwarded headers are not used for the per-IP hourly quota. */
function requestClientIp(req: IncomingMessage): string {
  const address = req.socket.remoteAddress
  if (typeof address === 'string' && address !== '') return address
  throw new HttpError(400, 'CLIENT_IP_REQUIRED', 'Pairing Challenge requires a client IP')
}

function encodeBytes(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }

function decodeBytes(value: unknown, name: string): Uint8Array {
  const encoded = requiredString(value, name)
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new HttpError(400, 'BODY_INVALID', `${name} must be canonical base64url`)
  }
  const decoded = Buffer.from(encoded, 'base64url')
  if (decoded.toString('base64url') !== encoded) throw new HttpError(400, 'BODY_INVALID', `${name} must be canonical base64url`)
  return new Uint8Array(decoded)
}

function decodeFixedBytes(value: unknown, name: string, length: number): Uint8Array {
  const bytes = decodeBytes(value, name)
  if (bytes.byteLength !== length) throw new TypeError(`${name} must contain ${String(length)} bytes`)
  return bytes
}

export { RelayWebSocketConsumer } from './relay.ts'
