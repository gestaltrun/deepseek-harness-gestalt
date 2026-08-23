/** Encrypted Companion Protocol codec over one attachment-bound Snow transport. */

import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  type CompanionMessage,
} from '@deepseek-ai/dsh-remote-protocol'
import { SnowCompanionChannel } from './reconnect.ts'

/** Versioned application codec that never admits raw decrypted control bytes as authority. */
export class SnowCompanionProtocolChannel {
  private readonly protocol = negotiateCompanionProtocol(
    createCompanionNegotiationChannel(),
    createCompanionVersionOffer('mobile'),
    createCompanionVersionOffer('desktop'),
  )

  /** @param channel - one completed attachment-bound IK channel. */
  constructor(private readonly channel: SnowCompanionChannel) {}

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

  /** Release the underlying Snow transport. */
  dispose(): void { this.channel.dispose() }
}
