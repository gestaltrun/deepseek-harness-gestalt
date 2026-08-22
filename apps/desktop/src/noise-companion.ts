/** Desktop creation of authenticated foreground synchronization over one Snow IK attachment. */

import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'

/** Seal the Desktop-authoritative revision for one attachment generation. */
export function sealDesktopForegroundSynchronization(
  channel: Pick<SnowCompanionProtocolChannel, 'seal'>,
  generation: number,
  desktopRevision: number,
): Uint8Array {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new TypeError('Desktop Noise Companion generation must be a positive safe integer')
  }
  if (!Number.isSafeInteger(desktopRevision) || desktopRevision <= 0) {
    throw new TypeError('Desktop Companion revision must be a positive safe integer')
  }
  return channel.seal({
    type: 'projection',
    projection: { type: 'foreground-sync', generation, desktopRevision },
  })
}
