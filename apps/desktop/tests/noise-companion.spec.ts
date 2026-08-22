import { describe, expect, it, vi } from 'vitest'
import { sealDesktopForegroundSynchronization } from '../src/noise-companion.ts'

describe('Desktop Noise Companion synchronization', () => {
  it('seals the versioned connection generation and Desktop revision', () => {
    const seal = vi.fn(() => Uint8Array.of(7, 8))
    expect(sealDesktopForegroundSynchronization({ seal }, 3, 11)).toEqual(Uint8Array.of(7, 8))
    expect(seal).toHaveBeenCalledWith({
      type: 'projection',
      projection: { type: 'foreground-sync', generation: 3, desktopRevision: 11 },
    })
    expect(() => sealDesktopForegroundSynchronization({ seal }, 0, 1)).toThrow('generation')
    expect(() => sealDesktopForegroundSynchronization({ seal }, 1, 0)).toThrow('revision')
  })
})
