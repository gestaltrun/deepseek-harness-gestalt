/** Three-installation WebdriverIO Electron-service acceptance config. */

import { join } from 'node:path'
import { browser } from '@wdio/globals'
import type {} from '@wdio/native-types'

const desktopRoot = join(import.meta.dirname, '..', '..')
const artifactRoot = required('DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR')

function capability(name: 'a1' | 'b1' | 'b2') {
  return {
    capabilities: {
      browserName: 'electron',
      'wdio:electronServiceOptions': {
        appEntryPoint: join(desktopRoot, 'out', 'main.mjs'),
        appArgs: [
          `--user-data-dir=${required(`DSH_PROJECT_MEMBERS_${name.toUpperCase()}_USER_DATA`)}`,
          `--dsh-e2e-profile=${required(`DSH_PROJECT_MEMBERS_${name.toUpperCase()}_PROFILE`)}`,
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
        captureMainProcessLogs: true,
        captureRendererLogs: true,
        logDir: join(artifactRoot, name, 'electron-logs'),
      },
    },
  }
}

export const config: WebdriverIO.MultiremoteConfig = {
  runner: 'local',
  specs: ['./electron.e2e.ts'],
  maxInstances: 1,
  logLevel: 'info',
  outputDir: join(artifactRoot, 'wdio'),
  waitforTimeout: 30_000,
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 300_000 },
  services: ['electron'],
  capabilities: {
    a1: capability('a1'),
    b1: capability('b1'),
    b2: capability('b2'),
  },
  afterTest: async (test, _context, result) => {
    const slug = test.title.replaceAll(/[^a-z0-9]+/gi, '-').replaceAll(/^-|-$/g, '').toLowerCase()
    for (const name of ['a1', 'b1', 'b2'] as const) {
      try {
        const instance = (browser as unknown as WebdriverIO.MultiRemoteBrowser).getInstance(name)
        await instance.saveScreenshot(join(artifactRoot, name, `${slug}-${result.passed ? 'pass' : 'fail'}.png`))
      } catch (error) {
        process.stderr.write(`unable to capture ${name} evidence: ${String(error)}\n`)
      }
    }
  },
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}
