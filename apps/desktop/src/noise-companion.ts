/** Desktop creation of authenticated foreground synchronization over one Snow IK attachment. */

import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'

/** Seal the Desktop-authoritative revision for one attachment generation. */
export function sealDesktopForegroundSynchronization(
  channel: Pick<SnowCompanionProtocolChannel, 'seal'>,
  generation: number,
  desktopRevision: number,
  desktopName: string,
): Uint8Array {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new TypeError('Desktop Noise Companion generation must be a positive safe integer')
  }
  if (!Number.isSafeInteger(desktopRevision) || desktopRevision <= 0) {
    throw new TypeError('Desktop Companion revision must be a positive safe integer')
  }
  if (desktopName.trim() === '' || desktopName.length > 128) {
    throw new TypeError('Desktop Companion name must contain 1-128 characters')
  }
  return channel.seal({
    type: 'projection',
    projection: { type: 'foreground-sync', desktopName, generation, desktopRevision },
  })
}
