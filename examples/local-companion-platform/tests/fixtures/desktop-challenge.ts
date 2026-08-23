#!/usr/bin/env node
/** Create a same-account Desktop pairing challenge against the local listen. */

import { webcrypto } from 'node:crypto'
import { loadPlatformEnvironment, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
} from '@deepseek-ai/dsh-platform-account-client'
import { parsePairingRendezvousId } from '@deepseek-ai/dsh-remote-access'
import { RemoteAccessHttpTransport } from '@deepseek-ai/dsh-remote-access-client'
import { createInsecureHttpsFetch } from '../../src/listen.ts'

const origin = process.env.LOCAL_COMPANION_ORIGIN ?? 'https://127.0.0.1:8443'
const environment = loadPlatformEnvironment({
  selection: 'development',
  development: {
    origin,
    callbackUrl: `${origin}/v1/account/oauth/github/callback`,
    githubClientId: 'gestalt-local-companion-development',
    credentialReference: 'credentials://github-oauth/local-companion-development',
    databaseIdentity: 'gestalt-local-companion-development',
    identityNamespace: 'gestalt-local-companion-development',
  },
  production: {
    origin: 'https://www.gestaltrun.com',
    callbackUrl: 'https://www.gestaltrun.com/v1/account/oauth/github/callback',
    githubClientId: 'Ov23lip9LTmnFuFpFeeV',
    credentialReference: 'credentials://github-oauth/production',
    databaseIdentity: 'gestalt',
    identityNamespace: 'gestalt-production',
  },
})
const fetch = createInsecureHttpsFetch()
const transport = new PlatformAccountHttpTransport({ environment, fetch })
const remote = new RemoteAccessHttpTransport({ environment, fetch })
const desktop = new PlatformAccountInstallation({
  environment,
  installationId: parseInstallationId('local-companion-desktop-cli'),
  installationKind: 'desktop',
  transport,
  store: new MemoryInstallationAccountStore(),
  systemBrowser: {
    open(url) {
      return fetch(url).then((response) => {
        if (response.status >= 400) throw new Error(`development login returned ${String(response.status)}`)
      })
    },
  },
  crypto: webcrypto as Crypto,
})
desktop.acceptPrivacy()
await desktop.beginLogin()
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  const result = await desktop.pollLogin()
  if (result.status === 'complete') break
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}
if (desktop.getSnapshot().account === undefined) throw new Error('desktop login did not complete')
const enabled = await remote.setMobileAccess({
  authentication: await desktop.authorizeCurrentInstallation(),
  enabled: true,
})
if (enabled.relay === undefined) throw new Error('Desktop did not issue Relay authority')
const challenge = await remote.createChallenge({
  authentication: await desktop.authorizeCurrentInstallation(),
  rendezvousId: parsePairingRendezvousId('rendezvous-sim'),
})
console.log(`DESKTOP_CHALLENGE link=${challenge.oneTimeLink}`)
const confirmBy = Date.now() + 180_000
while (Date.now() < confirmBy) {
  const pending = await remote.listPendingPairings(await desktop.authorizeCurrentInstallation())
  const first = pending[0]
  if (first !== undefined) {
    await remote.confirmPairing({
      authentication: await desktop.authorizeCurrentInstallation(),
      pendingPairingId: first.pendingPairingId,
    })
    console.log(`DESKTOP_CHALLENGE confirmed=${first.pendingPairingId}`)
    process.exit(0)
  }
  await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
}
throw new Error('Desktop challenge expired before Mobile completed it')
