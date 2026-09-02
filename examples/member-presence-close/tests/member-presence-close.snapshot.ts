import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const config = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('member presence last-window Offline keyless assembled path', () => {
  it('publishes Offline from window close and fails a routed ask with no queue', async () => {
    const result = await runLoaderSmoke({
      label: 'member-presence-close-keyless',
      tempDirPrefix: 'member-presence-close-keyless-',
      binScript: driver,
      libBinScript: driver,
      configPath: config,
      tsconfigPath: tsconfig,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatchInlineSnapshot(`
      "ROSTER afterHeartbeat=online
      ROSTER afterWindowClose=offline
      ASK code=MEMBER_OFFLINE queued=0
      "
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
