/**
 * In-window Desktop boot mark: a local HTML overlay from the first frame
 * until the Session Surface publishes `__DSH_SHELL_READY__`.
 * @module @deepseek-ai/dsh-desktop/boot-screen
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebContentsView, type BrowserWindow } from 'electron'
import { pollUntilTrue, probeShellReady } from './boot-session.ts'

const BOOT_HTML = join(dirname(fileURLToPath(import.meta.url)), 'boot.html')

/** Handle that removes the boot overlay exactly once. */
export interface BootScreen {
  dispose(): void
}

/**
 * Cover the window content with the local boot mark.
 * @param target - the Desktop Host window.
 * @returns a disposer that lifts the overlay.
 */
export function attachBootScreen(target: BrowserWindow): BootScreen {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const layout = (): void => {
    if (target.isDestroyed()) return
    const [width, height] = target.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  target.contentView.addChildView(view)
  layout()
  target.on('resize', layout)
  void view.webContents.loadFile(BOOT_HTML)
  let disposed = false
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      target.off('resize', layout)
      if (!target.isDestroyed()) target.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    },
  }
}

/**
 * Wait until the Session Surface has painted its settled UI or fail-loud page.
 * @param target - the window whose main `webContents` loaded the Host URL.
 * @param timeoutMs - maximum wait after `loadURL` resolves.
 * @returns after the ready flag is true, the window is gone, or the timeout elapses.
 */
export async function waitForShellReady(target: BrowserWindow, timeoutMs = 30_000): Promise<void> {
  await pollUntilTrue(
    async () => {
      if (target.isDestroyed()) return true
      return probeShellReady(code => target.webContents.executeJavaScript(code, true))
    },
    timeoutMs,
    {
      now: () => Date.now(),
      sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
    },
  )
}
