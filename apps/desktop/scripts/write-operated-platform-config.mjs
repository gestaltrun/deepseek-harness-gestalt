#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const output = process.argv[2]
if (output === undefined || output.trim() === '') {
  throw new TypeError('operated Platform config output path is required')
}

const config = {
  environment: 'production',
  origin: required('PLATFORM_ORIGIN'),
  callbackUrl: required('PLATFORM_GITHUB_CALLBACK'),
  githubClientId: required('PLATFORM_GITHUB_CLIENT_ID'),
  credentialReference: required('PLATFORM_GITHUB_CREDENTIAL_REFERENCE'),
  databaseIdentity: required('PLATFORM_POSTGRES_DATABASE'),
  identityNamespace: required('PLATFORM_IDENTITY_NAMESPACE'),
}
validateOrigin(config.origin, config.callbackUrl)
const path = resolve(output)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, JSON.stringify(config, undefined, 2) + '\n', { mode: 0o600 })

function required(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new TypeError(`${name} is required`)
  return value
}

function validateOrigin(originValue, callbackValue) {
  const origin = new URL(originValue)
  const callback = new URL(callbackValue)
  const hostname = origin.hostname.toLowerCase()
  const local = hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '0.0.0.0' || hostname === '[::1]' || hostname === '::1'
    || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
  if (local) throw new TypeError('PLATFORM_ORIGIN must not use a local host')
  if (origin.protocol !== 'https:' || originValue !== origin.origin
    || callback.protocol !== 'https:' || callback.origin !== origin.origin) {
    throw new TypeError('PLATFORM_ORIGIN and PLATFORM_GITHUB_CALLBACK must share one HTTPS origin')
  }
  if (callback.pathname !== '/v1/account/oauth/github/callback'
    || callback.search !== '' || callback.hash !== '') {
    throw new TypeError('PLATFORM_GITHUB_CALLBACK path is invalid')
  }
}
