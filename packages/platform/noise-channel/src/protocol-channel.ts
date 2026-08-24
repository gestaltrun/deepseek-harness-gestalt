/** Encrypted Companion Protocol codec over one attachment-bound Snow transport. */

import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionVersionOffer,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  RemoteProtocolError,
  type CompanionMessage,
  type NegotiatedCompanionProtocol,
} from '@deepseek-ai/dsh-remote-protocol'
import { SnowCompanionChannel } from './reconnect.ts'

/** Versioned application codec that never admits raw decrypted control bytes as authority. */
export class SnowCompanionProtocolChannel {
  /** Created only after both encrypted endpoint offers have crossed the Snow channel. */
  private constructor(
    private readonly channel: SnowCompanionChannel,
    private readonly protocol: NegotiatedCompanionProtocol,
  ) {}

  /** Negotiated application major that governs available Companion messages. */
  get applicationMajor(): NegotiatedCompanionProtocol['major'] { return this.protocol.major }

  /**
   * Begin one encrypted endpoint-offer exchange that alone can construct this codec.
   * @param channel - raw attachment-bound Snow transport.
   * @param endpoint - local endpoint direction carried by the encrypted offer.
   * @param majors - locally supported application majors.
   * @returns encrypted offer plus the single-settlement codec factory.
   */
  static begin(
    channel: SnowCompanionChannel,
    endpoint: 'mobile' | 'desktop',
    majors: readonly (1 | 2 | 3 | 4)[],
  ): SnowCompanionProtocolNegotiation {
    const local = createCompanionVersionOffer(endpoint, majors)
    const payload = channel.seal(encodeCompanionVersionOffer(local))
    let open = true
    return {
      payload,
      finish(peerPayload) {
        if (!open) throw new Error('Snow Companion negotiation is already settled')
        open = false
        try {
          const peer = decodeCompanionVersionOffer(channel.open(peerPayload))
          const protocol = endpoint === 'mobile'
            ? negotiateCompanionProtocol(createCompanionNegotiationChannel(), local, peer)
            : negotiateCompanionProtocol(createCompanionNegotiationChannel(), peer, local)
          return new SnowCompanionProtocolChannel(channel, protocol)
        } catch (error) {
          channel.dispose()
          throw error
        }
      },
      cancel() {
        if (!open) return
        open = false
        channel.dispose()
      },
    }
  }

  /** Encrypt one validated Companion message.
   * @param message - approved Companion operation, projection, or result.
   * @returns Noise ciphertext.
   */
  seal(message: CompanionMessage): Uint8Array {
    return this.channel.seal(encodeCompanionMessage(this.protocol, message))
  }

  /** Open one ordered Companion ciphertext.
   * @param ciphertext - next ordered Noise ciphertext.
   * @returns validated Companion message.
   */
  open(ciphertext: Uint8Array): CompanionMessage {
    return decodeCompanionMessage(this.protocol, this.channel.open(ciphertext))
  }

  /**
   * Test whether one message fits the codec negotiated by the remote endpoint exchange.
   * @param message - prospective Companion message.
   * @returns whether the negotiated codec admits the complete encoded message.
   */
  canEncode(message: CompanionMessage): boolean {
    try {
      encodeCompanionMessage(this.protocol, message)
      return true
    } catch (error) {
      /* v8 ignore else -- typed Companion messages leave encoder failures in RemoteProtocolError. */
      if (error instanceof RemoteProtocolError) {
        if (error.code === 'REMOTE_PROTOCOL_LIMIT_EXCEEDED') return false
        throw error
      }
      /* v8 ignore next -- typed Companion messages leave encoder failures in RemoteProtocolError. */
      throw error
    }
  }

  /** Release the underlying Snow transport. */
  dispose(): void { this.channel.dispose() }
}

/** One endpoint's encrypted offer and single-settlement negotiation owner. */
export interface SnowCompanionProtocolNegotiation {
  /** Encrypted local version offer that must cross the physical Snow channel. */
  readonly payload: Uint8Array
  /** Decrypt the peer offer and create the negotiated application codec. */
  finish(peerPayload: Uint8Array): SnowCompanionProtocolChannel
  /** Release the transport when the offer exchange is abandoned. */
  cancel(): void
}

/**
 * Begin one encrypted Companion version exchange after Snow IK completes.
 * @param channel - raw attachment-bound Snow transport.
 * @param endpoint - local endpoint direction carried by the encrypted offer.
 * @param majors - locally supported current and preceding application majors.
 * @returns encrypted offer plus the single-settlement codec factory.
 */
export function beginSnowCompanionProtocol(
  channel: SnowCompanionChannel,
  endpoint: 'mobile' | 'desktop',
  majors: readonly (1 | 2 | 3 | 4)[] = [4, 3],
): SnowCompanionProtocolNegotiation {
  return SnowCompanionProtocolChannel.begin(channel, endpoint, majors)
}
