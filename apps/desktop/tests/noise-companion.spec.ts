import { describe, expect, it, vi } from 'vitest'
import { sealDesktopForegroundSynchronization } from '../src/noise-companion.ts'

describe('Desktop Noise Companion synchronization', () => {
  it('seals the versioned connection generation and Desktop revision', () => {
    const seal = vi.fn(() => Uint8Array.of(7, 8))
    expect(sealDesktopForegroundSynchronization({ seal }, 3, 11, 'Authenticated Desktop')).toEqual(Uint8Array.of(7, 8))
    expect(seal).toHaveBeenCalledWith({
      type: 'projection',
      projection: { type: 'foreground-sync', desktopName: 'Authenticated Desktop', generation: 3, desktopRevision: 11 },
    })
    expect(() => sealDesktopForegroundSynchronization({ seal }, 0, 1, 'Authenticated Desktop')).toThrow('generation')
    expect(() => sealDesktopForegroundSynchronization({ seal }, 1, 0, 'Authenticated Desktop')).toThrow('revision')
  })
})
