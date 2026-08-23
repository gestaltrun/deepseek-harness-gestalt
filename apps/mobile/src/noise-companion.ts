/** Mobile projection of authenticated Companion messages from one Snow IK attachment. */

import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'
import type { CompanionResult } from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime } from './companion-lifecycle.ts'

interface MobileCompanionResultReceiver {
  /** @param result - decoded result authenticated by this physical channel. */
  acceptValidatedCompanionResult(result: CompanionResult): void
}

interface MobileCompanionSurfaceReceiver {
  /** @param message - authenticated Desktop surface baseline for this physical channel. */
  acceptValidatedDesktopResync(message: {
    type: 'desktop-resync'
    version: 1
    authenticated: true
    desktopName: string
    sessions: readonly []
    streaming: false
  }): void
}

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
    private readonly resultReceiver?: () => MobileCompanionResultReceiver | undefined,
    private readonly surfaceReceiver?: () => MobileCompanionSurfaceReceiver | undefined,
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
    if (message.type === 'result') {
      const receiver = this.resultReceiver?.()
      if (receiver === undefined) throw new Error('Authenticated Companion result has no active Mobile surface')
      receiver.acceptValidatedCompanionResult(message.result)
      return message
    }
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
    if (this.surfaceReceiver !== undefined) {
      const surface = this.surfaceReceiver()
      if (surface === undefined) throw new Error('Authenticated foreground synchronization has no Mobile surface')
      surface.acceptValidatedDesktopResync({
        type: 'desktop-resync', version: 1, authenticated: true,
        desktopName: message.projection.desktopName,
        sessions: [], streaming: false,
      })
    }
    return message
  }
}
