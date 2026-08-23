#!/usr/bin/env node
/** Keep the local two-instance Platform listening for Mobile and Desktop clients. */

import {
  LOCAL_COMPANION_LISTEN_CONFIG,
  startLocalCompanionPlatform,
} from '../../src/listen.ts'

const port = Number(process.env.LOCAL_COMPANION_PORT ?? '8443')
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new TypeError('LOCAL_COMPANION_PORT must be a TCP port')
}

const platform = await startLocalCompanionPlatform({
  ...LOCAL_COMPANION_LISTEN_CONFIG,
  port,
  entropy: 'secure',
  ...(process.env.LOCAL_COMPANION_PAGE_ORIGIN === undefined
    ? {}
    : { pageOrigin: process.env.LOCAL_COMPANION_PAGE_ORIGIN }),
})
console.log(`LOCAL_COMPANION origin=${platform.origin}`)
console.log(`LOCAL_COMPANION relay=${platform.relayUrl}`)

const stop = async (): Promise<void> => {
  await platform.close()
  process.exit(0)
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
