import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadMobilePlatformEnvironment } from '../src/platform-environment.ts'

const output = process.argv[2]
if (output === undefined || output === '') throw new Error('Mobile runtime identity output path is required')
const environment = loadMobilePlatformEnvironment(process.env)
const path = resolve(output)
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify({
  version: 1,
  origin: environment.origin,
  callbackUrl: environment.callbackUrl,
  githubClientId: environment.githubClientId,
  credentialReference: environment.credentialReference,
  databaseIdentity: environment.databaseIdentity,
  identityNamespace: environment.identityNamespace,
})}\n`)
