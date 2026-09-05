#!/usr/bin/env node
/** Source-only hidden BrowserWindow smoke. Loaded only by an Electron main process. */

import { writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { desktopWindowConstructorOptions, handleDesktopWindowActivate } from '../src/e2e-profile.ts'

const INLINE_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><title>hidden-window-smoke</title><body style="background:#1a1a2e;margin:0"></body>',
)

function parseResultPath(argv: readonly string[]): string {
  const prefix = '--dsh-hidden-window-result='
  const argument = argv.find(value => value.startsWith(prefix))
  if (argument === undefined) throw new TypeError('hidden-window smoke requires --dsh-hidden-window-result=')
  const path = argument.slice(prefix.length)
  if (path.length === 0) throw new TypeError('hidden-window result path must be non-empty')
  return path
}

function writeResult(path: string, result: unknown): void {
  writeFileSync(path, `${JSON.stringify(result)}\n`, { mode: 0o600 })
}

async function run(): Promise<void> {
  const resultPath = parseResultPath(process.argv)
  if (app.isPackaged) throw new Error('hidden-window smoke is source-only')
  await app.whenReady()
  const options = desktopWindowConstructorOptions('hidden')
  const window = new BrowserWindow({
    ...options,
    width: 320,
    height: 240,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  if (window.isVisible()) throw new Error('hidden-window smoke constructed a visible BrowserWindow')
  await window.loadURL(INLINE_PAGE)
  if (window.isVisible()) throw new Error('hidden-window smoke became visible after load')
  const activate = handleDesktopWindowActivate('hidden', window)
  if (activate !== 'handled') throw new Error('hidden-window smoke activate fencing missed the live window')
  if (window.isVisible()) throw new Error('hidden-window smoke became visible after activate fencing')
  const image = await window.webContents.capturePage()
  const size = image.getSize()
  if (window.isVisible()) throw new Error('hidden-window smoke became visible after capture')
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
    throw new Error('hidden-window smoke captured an empty or nonpositive page')
  }
  writeResult(resultPath, {
    visible: false,
    shownOnCreate: false,
    activate,
    captureEmpty: false,
    captureWidth: size.width,
    captureHeight: size.height,
  })
  window.destroy()
  app.quit()
}

void run().catch((error: unknown) => {
  try {
    writeResult(parseResultPath(process.argv), {
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    })
  } catch {
    // Result path missing; Electron still exits non-zero.
  }
  process.exitCode = 1
  app.quit()
})
