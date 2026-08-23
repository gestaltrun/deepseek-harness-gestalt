import { createCipheriv, createDecipheriv, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  decodeCompanionVersionOffer,
  decodeRelayMessage,
  deriveCompanionAttachmentKey,
  encodeCompanionMessage,
  encodeCompanionVersionOffer,
  encodeRelayMessage,
  hashCompanionCiphertext,
  negotiateCompanionProtocol,
  negotiateRelayTransportVersion,
  openCompanionAttachment,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayAttachmentId,
  parseRelayRouteId,
  RemoteProtocolError,
  sealCompanionAttachment,
  type RelayAttachmentId,
} from '@deepseek-ai/dsh-remote-protocol'

/** Cordis name for the keyless Remote Protocol acceptance composition. */
export const name = 'remote-protocol-keyless-scenario'

/** Run one encrypted Mobile request and Desktop-confirmed response through an opaque Relay. */
export async function apply(_ctx: Context): Promise<void> {
  const transportVersion = negotiateRelayTransportVersion([1], [1])
  console.log(`TRANSPORT version=${String(transportVersion)}`)

  const cipher = new KeylessHarnessCipher()
  const routeId = parseRelayRouteId('route-keyless')
  const mobileAttachment = parseRelayAttachmentId(`mobile-${randomUUID()}`)
  const desktopAttachment = parseRelayAttachmentId(`desktop-${randomUUID()}`)
  const mobileOffer = createCompanionVersionOffer('mobile')
  const desktopOffer = createCompanionVersionOffer('desktop')
  const mobileChannel = createCompanionNegotiationChannel()
  const desktopChannel = createCompanionNegotiationChannel()
  const mobileOfferAtDesktop = decodeCompanionVersionOffer(cipher.open(forward(
    routeId,
    mobileAttachment,
    desktopAttachment,
    cipher.seal(encodeCompanionVersionOffer(mobileOffer)),
  )))
  const desktopOfferAtMobile = decodeCompanionVersionOffer(cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionVersionOffer(desktopOffer)),
  )))
  const mobileProtocol = negotiateCompanionProtocol(mobileChannel, mobileOffer, desktopOfferAtMobile)
  const desktopProtocol = negotiateCompanionProtocol(desktopChannel, mobileOfferAtDesktop, desktopOffer)
  console.log(`COMPANION version=${String(mobileProtocol.major)} security=preserved`)

  const operation = {
    type: 'operation',
    operation: {
      type: 'submit-prompt',
      operationId: parseCompanionOperationId('operation-keyless'),
      sessionId: parseCompanionSessionId('session-keyless'),
      text: 'continue from Mobile',
    },
  } as const
  const operationPlaintext = encodeCompanionMessage(mobileProtocol, operation)
  const relayOperation = forward(
    routeId,
    mobileAttachment,
    desktopAttachment,
    cipher.seal(operationPlaintext),
  )
  const received = decodeCompanionMessage(desktopProtocol, cipher.open(relayOperation))
  if (received.type !== 'operation' || received.operation.type !== 'submit-prompt') {
    throw new Error('Desktop did not receive the Mobile operation')
  }
  const relayPlaintext = new TextDecoder().decode(encodeRelayMessage({
    type: 'ciphertext',
    transportVersion,
    routeId,
    sourceAttachmentId: mobileAttachment,
    targetAttachmentId: desktopAttachment,
    ciphertext: relayOperation,
  })).includes(received.operation.text)
  console.log(`MOBILE_REQUEST encrypted=${String(!bytesEqual(operationPlaintext, relayOperation))} relayPlaintext=${String(relayPlaintext)} type=${received.operation.type}`)

  const confirmed = {
    type: 'result',
    result: {
      type: 'confirmed',
      operationId: received.operation.operationId,
      committedAt: 1_787_027_200_000,
      outcome: 'accepted',
    },
  } as const
  const mobileResult = decodeCompanionMessage(mobileProtocol, cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionMessage(desktopProtocol, confirmed)),
  )))
  if (mobileResult.type !== 'result' || mobileResult.result.type !== 'confirmed') throw new Error('Mobile did not receive the Desktop result')
  console.log(`DESKTOP_RESPONSE confirmed=true outcome=${mobileResult.result.outcome}`)

  const attachmentKey = await deriveCompanionAttachmentKey(Buffer.alloc(32, 31))
  const attachmentPlaintext = new TextEncoder().encode('attachment plaintext owned by endpoints')
  const sealedAttachment = await sealCompanionAttachment(attachmentKey, attachmentPlaintext)
  const retainedByPlatform = sealedAttachment.ciphertext
  const includesPlaintext = new TextDecoder().decode(retainedByPlatform)
    .includes('attachment plaintext owned by endpoints')
  const attachmentOffer = {
    type: 'operation',
    operation: {
      type: 'offer-attachment',
      operationId: parseCompanionOperationId('operation-attachment'),
      sessionId: parseCompanionSessionId('session-keyless'),
      capability: 'A'.repeat(43) as never,
      ciphertextSha256: sealedAttachment.ciphertextSha256,
      byteLength: sealedAttachment.ciphertext.byteLength,
      expiresAt: 1_787_027_200_000,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
    },
  } as const
  const offerFrame = forward(
    routeId,
    mobileAttachment,
    desktopAttachment,
    cipher.seal(encodeCompanionMessage(mobileProtocol, attachmentOffer)),
  )
  const receivedOffer = decodeCompanionMessage(desktopProtocol, cipher.open(offerFrame))
  if (receivedOffer.type !== 'operation' || receivedOffer.operation.type !== 'offer-attachment') {
    throw new Error('Desktop did not receive the attachment offer')
  }
  const verified = await hashCompanionCiphertext(retainedByPlatform) === receivedOffer.operation.ciphertextSha256
  const decryptedAttachment = verified
    ? await openCompanionAttachment(attachmentKey, retainedByPlatform)
    : undefined
  const submitted = decryptedAttachment !== undefined
    && new TextDecoder().decode(decryptedAttachment) === 'attachment plaintext owned by endpoints'
  const rejection = {
    type: 'result',
    result: {
      type: 'attachment-rejected',
      operationId: receivedOffer.operation.operationId,
      reason: 'hash-mismatch',
    },
  } as const
  const mobileRejection = decodeCompanionMessage(mobileProtocol, cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionMessage(desktopProtocol, rejection)),
  )))
  if (mobileRejection.type !== 'result') throw new Error('Mobile did not receive the rejection')
  console.log(`ATTACHMENT platformPlaintext=${String(includesPlaintext)} hashVerified=${String(verified)} submitted=${String(submitted)} controlFrameBytes=${String(offerFrame.byteLength)} rejectionReason=${mobileRejection.result.type === 'attachment-rejected' ? mobileRejection.result.reason : 'unknown'}`)

  const searchOperation = {
    type: 'operation' as const,
    operation: {
      type: 'search-sessions' as const,
      operationId: parseCompanionOperationId('operation-search'),
      query: 'attachment receipt',
    },
  }
  const desktopSearch = decodeCompanionMessage(desktopProtocol, cipher.open(forward(
    routeId,
    mobileAttachment,
    desktopAttachment,
    cipher.seal(encodeCompanionMessage(mobileProtocol, searchOperation)),
  )))
  if (desktopSearch.type !== 'operation' || desktopSearch.operation.type !== 'search-sessions') {
    throw new Error('Desktop did not receive the authoritative Session search')
  }
  const searchResult = {
    type: 'result' as const,
    result: {
      type: 'session-search' as const,
      operationId: desktopSearch.operation.operationId,
      items: [{
        sessionId: parseCompanionSessionId('session-keyless'),
        snippet: 'attachment receipt from Desktop index',
      }],
      hasMore: false,
    },
  }
  const mobileSearch = decodeCompanionMessage(mobileProtocol, cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionMessage(desktopProtocol, searchResult)),
  )))
  if (mobileSearch.type !== 'result' || mobileSearch.result.type !== 'session-search') {
    throw new Error('Mobile did not receive the authoritative Session search result')
  }
  console.log(`SESSION_SEARCH authority=desktop hits=${String(mobileSearch.result.items.length)} hasMore=${String(mobileSearch.result.hasMore)}`)

  const host400 = {
    type: 'result' as const,
    result: {
      type: 'operation-failed' as const,
      operationId: desktopSearch.operation.operationId,
      failure: {
        kind: 'http' as const,
        code: 'HOST_HTTP_STATUS' as const,
        message: 'Desktop Host returned HTTP 400',
        status: 400,
      },
    },
  }
  const mobileHost400 = decodeCompanionMessage(mobileProtocol, cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionMessage(desktopProtocol, host400)),
  )))
  if (mobileHost400.type !== 'result' || mobileHost400.result.type !== 'operation-failed') {
    throw new Error('Mobile did not receive the Host HTTP failure')
  }
  console.log(`HOST_FAILURE kind=${mobileHost400.result.failure.kind} code=${mobileHost400.result.failure.code} status=${mobileHost400.result.failure.kind === 'http' ? String(mobileHost400.result.failure.status) : 'none'}`)

  const statusQuery = {
    type: 'operation',
    operation: {
      type: 'query-operation-status',
      operationId: received.operation.operationId,
    },
  } as const
  const queryPlaintext = encodeCompanionMessage(mobileProtocol, statusQuery)
  const relayQuery = forward(
    routeId,
    mobileAttachment,
    desktopAttachment,
    cipher.seal(queryPlaintext),
  )
  const receivedQuery = decodeCompanionMessage(desktopProtocol, cipher.open(relayQuery))
  if (receivedQuery.type !== 'operation' || receivedQuery.operation.type !== 'query-operation-status') {
    throw new Error('Desktop did not receive the operation-status query')
  }
  const committedStatus = {
    type: 'result',
    result: {
      type: 'status',
      operationId: receivedQuery.operation.operationId,
      committed: {
        type: 'confirmed',
        operationId: receivedQuery.operation.operationId,
        committedAt: 1_787_027_200_000,
        outcome: 'accepted',
      },
    },
  } as const
  const mobileStatus = decodeCompanionMessage(mobileProtocol, cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionMessage(desktopProtocol, committedStatus)),
  )))
  if (mobileStatus.type !== 'result' || mobileStatus.result.type !== 'status' || !('committed' in mobileStatus.result)) {
    throw new Error('Mobile did not receive the Desktop status answer')
  }
  console.log(`RECONNECT_QUERY operationId=${mobileStatus.result.operationId} committed=true original=${mobileStatus.result.committed.outcome}`)

  const absentStatus = {
    type: 'result',
    result: {
      type: 'status',
      operationId: parseCompanionOperationId('operation-never-submitted'),
      absent: true,
    },
  } as const
  const mobileAbsent = decodeCompanionMessage(mobileProtocol, cipher.open(forward(
    routeId,
    desktopAttachment,
    mobileAttachment,
    cipher.seal(encodeCompanionMessage(desktopProtocol, absentStatus)),
  )))
  if (mobileAbsent.type !== 'result' || mobileAbsent.result.type !== 'status' || !('absent' in mobileAbsent.result)) {
    throw new Error('Mobile did not receive the explicit absent answer')
  }
  console.log(`RECONNECT_QUERY operationId=${mobileAbsent.result.operationId} committed=false notSubmitted=true`)

  let applicationPlaintextSent = false
  try {
    negotiateCompanionProtocol(
      mobileChannel,
      createCompanionVersionOffer('mobile', [1]),
      createCompanionVersionOffer('desktop', [2]),
    )
  } catch (error) {
    if (!(error instanceof RemoteProtocolError)) throw error
    console.log(`NEGOTIATION mismatch=${error.code} update=${error.updateEndpoint ?? 'unknown'} applicationPlaintextSent=${String(applicationPlaintextSent)}`)
    return
  }
  applicationPlaintextSent = true
  throw new Error('incompatible Companion majors unexpectedly negotiated')
}

function forward(
  routeId: ReturnType<typeof parseRelayRouteId>,
  sourceAttachmentId: RelayAttachmentId,
  targetAttachmentId: RelayAttachmentId,
  ciphertext: Uint8Array,
): Uint8Array {
  const forwarded = decodeRelayMessage(encodeRelayMessage({
    type: 'ciphertext',
    transportVersion: 1,
    routeId,
    sourceAttachmentId,
    targetAttachmentId,
    ciphertext,
  }))
  if (forwarded.type !== 'ciphertext') throw new Error('Relay did not forward ciphertext')
  return forwarded.ciphertext
}

/** Example-only authenticated cipher used by the assembled acceptance path. */
export class KeylessHarnessCipher {
  private readonly key = Buffer.alloc(32, 29)
  private counter = 0

  /**
   * Encrypt one Companion message with the example-only key.
   * @param plaintext - encoded Companion application bytes.
   * @returns nonce-prefixed authenticated ciphertext.
   */
  seal(plaintext: Uint8Array): Uint8Array {
    this.counter += 1
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(this.counter, 8)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return new Uint8Array(Buffer.concat([nonce, encrypted, cipher.getAuthTag()]))
  }

  /**
   * Decrypt one ciphertext produced by this example instance.
   * @param sealed - nonce-prefixed authenticated ciphertext.
   * @returns encoded Companion application bytes.
   */
  open(sealed: Uint8Array): Uint8Array {
    const nonce = sealed.slice(0, 12)
    const tag = sealed.slice(sealed.byteLength - 16)
    const encrypted = sealed.slice(12, sealed.byteLength - 16)
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
    decipher.setAuthTag(tag)
    return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]))
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
