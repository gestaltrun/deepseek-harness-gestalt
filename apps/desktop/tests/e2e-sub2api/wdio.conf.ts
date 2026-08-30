/** WebdriverIO Electron service configuration for the release-backed Sub2API flow. */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browser } from '@wdio/globals'
import type {} from '@wdio/native-types'
import { recordOwnedProcesses } from './helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..', '..')
const artifactDir = process.env.DSH_SUB2API_E2E_ARTIFACT_DIR
if (artifactDir === undefined || artifactDir.length === 0) {
  throw new TypeError('DSH_SUB2API_E2E_ARTIFACT_DIR is required')
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./sub2api-install.e2e.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  outputDir: join(artifactDir, 'wdio'),
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 900_000 },
  services: ['electron'],
  capabilities: [{
    browserName: 'electron',
    'wdio:electronServiceOptions': {
      appEntryPoint: join(desktopRoot, 'out', 'main.mjs'),
      appArgs: [
        `--user-data-dir=${process.env.DSH_SUB2API_E2E_USER_DATA ?? ''}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      captureMainProcessLogs: true,
      captureRendererLogs: true,
      logDir: join(artifactDir, 'electron-logs'),
    },
    'goog:chromeOptions': {
      args: [`--remote-debugging-port=${process.env.DSH_SUB2API_E2E_CDP_PORT ?? '0'}`],
    },
  }],
  afterTest: async (test, _context, result) => {
    await mkdir(artifactDir, { recursive: true })
    await recordOwnedProcesses(false)
    const slug = test.title.replaceAll(/[^a-z0-9]+/giu, '-').replaceAll(/^-|-$/gu, '').toLowerCase()
    try {
      await browser.saveScreenshot(join(artifactDir, `${slug}-${result.passed ? 'pass' : 'fail'}.png`))
    } catch (error) {
      throw new Error('Sub2API Electron e2e screenshot capture failed', { cause: error })
    }
  },
}
