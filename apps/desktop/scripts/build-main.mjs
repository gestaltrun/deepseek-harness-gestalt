#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePackagedSub2ApiSources } from './write-sub2api-sources.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)
const operatedPlatformConfig = positional(args)[0] ?? process.env.DSH_DESKTOP_OPERATED_PLATFORM_CONFIG
if (operatedPlatformConfig === undefined || operatedPlatformConfig.trim() === '') {
  throw new TypeError('Desktop build requires an operated Platform configuration path')
}
const packPlatform = flag('--platform', args) ?? process.env.DSH_DESKTOP_SUB2API_PLATFORM ?? process.platform
const packArch = flag('--arch', args) ?? process.env.DSH_DESKTOP_SUB2API_ARCH ?? process.arch
const operatedPlatformSource = JSON.parse(await readFile(operatedPlatformConfig, 'utf8'))
const publicOperatedPlatformConfig = parseOperatedPlatformConfig(operatedPlatformSource)
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(root, 'out', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // CommonJS runtime dependencies remain loadable by Electron's ESM main process.
  external: ['electron', 'electron-updater', 'https-proxy-agent', 'ws'],
  logLevel: 'info',
})
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'relay-node-helper-worker.ts')],
  outfile: join(root, 'out', 'relay-node-helper.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
})
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'system-node-fetch-helper-worker.ts')],
  outfile: join(root, 'out', 'system-node-fetch-helper.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
})
await cp(join(root, 'src', 'preload.cjs'), join(root, 'out', 'preload.cjs'))
await writeFile(
  join(root, 'out', 'operated-platform.json'),
  JSON.stringify(publicOperatedPlatformConfig, undefined, 2) + '\n',
)
await writePackagedSub2ApiSources({ root, platform: packPlatform, arch: packArch })
await mkdir(join(root, 'out', 'build'), { recursive: true })
await cp(join(root, 'build', 'icon.png'), join(root, 'out', 'build', 'icon.png'))

function flag(name, argv) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function positional(argv) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') continue
    if (argv[index] === '--platform' || argv[index] === '--arch') {
      index += 1
      continue
    }
    values.push(argv[index])
  }
  return values
}

function parseOperatedPlatformConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop operated Platform configuration must be an object')
  }
  const fields = [
    'environment',
    'origin', 'callbackUrl', 'githubClientId', 'credentialReference', 'databaseIdentity', 'identityNamespace',
    'companionAttachmentHostTimeoutMs', 'remoteRelay',
  ]
  const unknown = Object.keys(value).filter(field => !fields.includes(field))
  if (unknown.length > 0) {
    throw new TypeError(`Desktop operated Platform configuration contains unknown fields: ${unknown.join(', ')}`)
  }
  if (value.environment !== 'production') {
    throw new TypeError('Desktop operated Platform configuration requires environment production')
  }
  for (const field of [
    'origin', 'callbackUrl', 'githubClientId', 'credentialReference', 'databaseIdentity', 'identityNamespace',
  ]) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new TypeError(`Desktop operated Platform configuration requires ${field}`)
    }
  }
  if (!Number.isSafeInteger(value.companionAttachmentHostTimeoutMs)
    || value.companionAttachmentHostTimeoutMs <= 0) {
    throw new TypeError('Desktop operated Platform configuration requires companionAttachmentHostTimeoutMs')
  }
  return {
    environment: 'production',
    origin: value.origin,
    callbackUrl: value.callbackUrl,
    githubClientId: value.githubClientId,
    credentialReference: value.credentialReference,
    databaseIdentity: value.databaseIdentity,
    identityNamespace: value.identityNamespace,
    companionAttachmentHostTimeoutMs: value.companionAttachmentHostTimeoutMs,
    remoteRelay: parseRemoteRelay(value.remoteRelay),
  }
}

function parseRemoteRelay(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop operated Platform configuration requires remoteRelay')
  }
  const fields = [
    'url', 'attachTimeoutMs', 'negotiationTimeoutMs', 'heartbeatIntervalMs',
    'reconnectDelayMs', 'inboundMaxBytes', 'inboundMaxMessages',
  ]
  const unknown = Object.keys(value).filter(field => !fields.includes(field))
  if (unknown.length > 0) {
    throw new TypeError(`Desktop remoteRelay configuration contains unknown fields: ${unknown.join(', ')}`)
  }
  if (typeof value.url !== 'string' || new URL(value.url).protocol !== 'wss:') {
    throw new TypeError('Desktop remoteRelay.url must use WSS')
  }
  for (const field of fields.slice(1)) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw new TypeError(`Desktop remoteRelay.${field} must be a positive safe integer`)
    }
  }
  return Object.fromEntries(fields.map(field => [field, value[field]]))
}
