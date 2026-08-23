/**
 * In-process Electron Browser Runtime owned by the Desktop Host.
 * @module @deepseek-ai/dsh-desktop/browser-runtime
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ElectronBrowserRuntime, { listenElectronBrowserHttp } from '@deepseek-ai/dsh-browser-runtime-electron'
import type { ElectronBrowserHttpServer, ElectronWindowBounds } from '@deepseek-ai/dsh-browser-runtime-electron'
import type { BrowserPresentTarget } from './browser-present.ts'

/** Loopback HTTP origin plus the token file for the Web Host. */
export interface DesktopBrowserRuntime {
  /** Loopback origin the Tandem-shaped HTTP client uses. */
  readonly origin: string
  /** Bearer-token file the HTTP client reads. */
  readonly tokenFile: string
  /** Directory that stores only the loopback API token, not Chromium partitions. */
  readonly tokenDir: string
  /** Place one official page over the Desktop Host window. */
  present(target: BrowserPresentTarget, bounds: ElectronWindowBounds, parent: unknown): void
  /** Hide one official page when its sidebar tab is not visible. */
  conceal(target: BrowserPresentTarget): void
  /** Put the presented page above Host chrome after an overlay closes. */
  raisePresented(): void
  /** Stop the HTTP listener and dispose hidden windows. */
  dispose(): Promise<void>
}

/**
 * Start one in-process Electron Browser Runtime and bind Tandem's HTTP vocabulary.
 * Chromium persist partitions stay at Electron `userData/Partitions/<name>`.
 * The loopback token file lives under `userData/browser-runtime`.
 * @param userData - Electron `app.getPath('userData')`.
 * @returns origin, token file, and disposer.
 */
export async function startDesktopBrowserRuntime(userData: string): Promise<DesktopBrowserRuntime> {
  const tokenDir = join(userData, 'browser-runtime')
  const tokenFile = join(tokenDir, 'api-token')
  await mkdir(tokenDir, { recursive: true })
  const ctx = new Context()
  try {
    await ctx.plugin(ElectronBrowserRuntime, { idPrefix: 'gestalt' })
    const server: ElectronBrowserHttpServer = await listenElectronBrowserHttp({
      runtime: ctx.browserRuntime,
      tokenFile,
      idPrefix: 'gestalt',
    })
    return {
      origin: server.origin,
      tokenFile,
      tokenDir,
      present: (target, bounds, parent) => {
        const runtime = ctx.browserRuntime as ElectronBrowserRuntime
        runtime.present(target as never, bounds, parent)
      },
      conceal: (target) => {
        const runtime = ctx.browserRuntime as ElectronBrowserRuntime
        runtime.conceal(target as never)
      },
      raisePresented: () => {
        const runtime = ctx.browserRuntime as ElectronBrowserRuntime
        runtime.raisePresented()
      },
      dispose: async () => {
        await server.close()
        await ctx.fiber.dispose()
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
