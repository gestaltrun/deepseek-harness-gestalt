import { describe, expect, it, vi } from 'vitest'
import { projectDesktopRendererEvent } from '../src/renderer-projection.ts'

describe('Desktop renderer projection', () => {
  it('sends one state event to every active renderer', () => {
    const main = { isDestroyed: () => false, send: vi.fn() }
    const overlay = { isDestroyed: () => false, send: vi.fn() }
    const payload = { status: 'signed-in' }

    projectDesktopRendererEvent([main, overlay], 'desktop:account-snapshot-changed', payload)

    expect(main.send).toHaveBeenCalledWith('desktop:account-snapshot-changed', payload)
    expect(overlay.send).toHaveBeenCalledWith('desktop:account-snapshot-changed', payload)
  })

  it('excludes destroyed renderers and de-duplicates an active renderer', () => {
    const active = { isDestroyed: () => false, send: vi.fn() }
    const destroyed = { isDestroyed: () => true, send: vi.fn() }

    projectDesktopRendererEvent([active, undefined, destroyed, active], 'desktop:pairing-snapshot-changed', null)

    expect(active.send).toHaveBeenCalledOnce()
    expect(destroyed.send).not.toHaveBeenCalled()
  })
})
