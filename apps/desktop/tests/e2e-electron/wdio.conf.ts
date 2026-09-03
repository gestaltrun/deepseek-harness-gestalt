/** WebdriverIO Electron service config for the built Desktop Host. */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browser } from '@wdio/globals'
import type {} from '@wdio/native-types'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..', '..')
const artifactDir = process.env.DSH_ELECTRON_E2E_ARTIFACT_DIR
if (artifactDir === undefined || artifactDir.length === 0) {
  throw new TypeError('DSH_ELECTRON_E2E_ARTIFACT_DIR is required')
}

const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (url !== 'https://electronjs.org/headers/index.json') return await nativeFetch(input, init)
  // Electron Service otherwise waits without a deadline instead of reaching
  // its bundled electron-to-chromium fallback when the metadata host stalls.
  const timeout = AbortSignal.timeout(3_000)
  const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout])
  return await nativeFetch(input, { ...init, signal })
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./phone-tab.e2e.ts', './phone-tab-unresolved.e2e.ts'],
  maxInstances: 1,
  logLevel: 'info',
  outputDir: join(artifactDir, 'wdio'),
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 180_000,
  },
  services: ['electron'],
  capabilities: [{
    browserName: 'electron',
    'wdio:electronServiceOptions': {
      appEntryPoint: join(desktopRoot, 'out', 'main.mjs'),
      appArgs: [
        `--user-data-dir=${process.env.DSH_ELECTRON_E2E_USER_DATA ?? ''}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      captureMainProcessLogs: true,
      captureRendererLogs: true,
      logDir: join(artifactDir, 'electron-logs'),
    },
    'goog:chromeOptions': {
      args: [`--remote-debugging-port=${process.env.DSH_ELECTRON_E2E_CDP_PORT ?? '0'}`],
    },
  }],
  afterTest: async (test, _context, result) => {
    await mkdir(artifactDir, { recursive: true })
    const slug = test.title.replaceAll(/[^a-z0-9]+/gi, '-').replaceAll(/^-|-$/g, '').toLowerCase()
    const suffix = result.passed ? 'pass' : 'fail'
    try {
      await browser.saveScreenshot(join(artifactDir, `${slug}-${suffix}-window.png`))
    } catch (error) {
      process.stderr.write(`unable to capture Electron window evidence: ${String(error)}\n`)
    }
  },
}
