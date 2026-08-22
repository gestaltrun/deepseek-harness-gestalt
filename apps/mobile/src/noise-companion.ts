/** Mobile projection of authenticated Companion messages from one Snow IK attachment. */

import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'
import { CompanionForegroundRuntime } from './companion-lifecycle.ts'

/** Decrypts one physical connection's Companion frames before granting foreground synchronization. */
export class MobileNoiseCompanionReceiver {
  /**
   * @param channel - completed attachment-bound IK and Companion codec.
   * @param generation - physical connection generation bound into the IK prologue.
   * @param runtime - foreground authority owner.
   */
  constructor(
    private readonly channel: Pick<SnowCompanionProtocolChannel, 'open'>,
    private readonly generation: number,
    private readonly runtime: CompanionForegroundRuntime,
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new TypeError('Mobile Noise Companion generation must be a positive safe integer')
    }
  }

  /**
   * Open and validate the next ordered Companion ciphertext.
   * @param ciphertext - next Snow transport message from the bound Desktop attachment.
   * @returns decoded message; a matching foreground sync also updates mutation authority.
   */
  receive(ciphertext: Uint8Array): ReturnType<SnowCompanionProtocolChannel['open']> {
    const message = this.channel.open(ciphertext)
    if (message.type !== 'projection' || message.projection.type !== 'foreground-sync') return message
    if (message.projection.generation !== this.generation) {
      throw new Error('Authenticated foreground synchronization belongs to another connection generation')
    }
    const receiver = this.runtime.bindValidatedDesktopResync()
    if (receiver === undefined || !receiver.acceptValidatedDesktopResync({
      type: 'desktop-resync',
      version: 1,
      authenticated: true,
    })) {
      throw new Error('Authenticated foreground synchronization has no active connection owner')
    }
    return message
  }
}
