import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { apply as applyInvariant, name } from '../src/invariant.ts'
import {
  CHROME_OVERLAY_SHOW, DESKTOP_OVERLAY_PARAM,
  UPDATER_CHECK_NOW, UPDATER_DOWNLOAD_NOW, UPDATER_GET_STATUS,
  UPDATER_QUIT_AND_INSTALL, UPDATER_STATUS_CHANGED,
  WINDOW_CLOSE, WINDOW_MAXIMIZE, WINDOW_MINIMIZE,
} from '../src/protocol.ts'

describe('host half and protocol', () => {
  it('exports a no-op host apply and the updater channel names', () => {
    apply()
    expect(name).toBe('client-ui-desktop-invariant')
    expect(UPDATER_GET_STATUS).toBe('updater:getStatus')
    expect(UPDATER_CHECK_NOW).toBe('updater:checkNow')
    expect(UPDATER_DOWNLOAD_NOW).toBe('updater:downloadNow')
    expect(UPDATER_QUIT_AND_INSTALL).toBe('updater:quitAndInstall')
    expect(UPDATER_STATUS_CHANGED).toBe('updater:status-changed')
    expect(WINDOW_MINIMIZE).toBe('window:minimize')
    expect(WINDOW_MAXIMIZE).toBe('window:maximize')
    expect(WINDOW_CLOSE).toBe('window:close')
    expect(CHROME_OVERLAY_SHOW).toBe('chrome:overlayShow')
    expect(DESKTOP_OVERLAY_PARAM).toBe('dsh-desktop-overlay')
  })

  it('registers the invariant companion', async () => {
    const dispose = vi.fn()
    const install = vi.fn()
    const register = vi.fn((pkg: string, installer: () => void) => {
      expect(pkg).toBe('@deepseek-ai/dsh-client-ui-desktop')
      install()
      installer()
      return dispose
    })
    const ctx = {
      invariants: { register },
    }
    const registered = await applyInvariant(ctx as never)

    expect(register).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
    expect(registered).toBe(dispose)
    registered()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
