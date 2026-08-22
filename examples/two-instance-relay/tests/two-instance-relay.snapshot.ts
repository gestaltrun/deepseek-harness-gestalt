import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const config = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('two-instance Remote Relay Snow assembled path', () => {
  it('pairs through the endpoint mailbox and authenticates across non-sticky Platform instances', async () => {
    const result = await runLoaderSmoke({
      label: 'two-instance-relay-snow',
      tempDirPrefix: 'two-instance-relay-snow-',
      binScript: driver,
      libBinScript: driver,
      configPath: config,
      tsconfigPath: tsconfig,
      processTimeoutMs: 120_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatchInlineSnapshot(`
      "PLATFORM endpointProtocol=wss: endpointPath=/v1/remote-access/relay endpointCount=1 nonSticky=true mobile=platform-a desktop=platform-b productAuthority=true distinctCredentials=true
      PAIRING endpointMailbox=true platformPsk=false sealedAuthority=true ik=true
      ROUND_TRIP encrypted=true relayBusinessValue=false outcome=accepted
      PAIRING_ACTIVITY online=true lastAccessCurrent=true
      LIFECYCLE observed=quit offline=true retainedCiphertextValues=0
      PAIRING_DISCONNECT online=false lastAccessPreserved=true
      AUTHORITY disableInstance=platform-replacement routeOffline=true
      "
    `)
  }, 135_000)
})
