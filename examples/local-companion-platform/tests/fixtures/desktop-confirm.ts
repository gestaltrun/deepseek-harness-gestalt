#!/usr/bin/env node
/** Confirm the first pending pairing for the local octocat Desktop. */

import { webcrypto } from 'node:crypto'
import { loadPlatformEnvironment, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
} from '@deepseek-ai/dsh-platform-account-client'
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
const desktop = new PlatformAccountInstallation({
  environment,
  installationId: parseInstallationId('local-companion-desktop-cli'),
  installationKind: 'desktop',
  transport: new PlatformAccountHttpTransport({ environment, fetch }),
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
const remote = new RemoteAccessHttpTransport({ environment, fetch })
desktop.acceptPrivacy()
await desktop.beginLogin()
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  const result = await desktop.pollLogin()
  if (result.status === 'complete') break
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}
const pending = await remote.listPendingPairings(await desktop.authorizeCurrentInstallation())
const first = pending[0]
if (first === undefined) throw new Error('no pending pairing to confirm')
await remote.confirmPairing({
  authentication: await desktop.authorizeCurrentInstallation(),
  pendingPairingId: first.pendingPairingId,
})
console.log(`DESKTOP_CONFIRM pending=${first.pendingPairingId} words=${first.authenticationWords.join('-')}`)
