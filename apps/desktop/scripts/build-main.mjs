#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const operatedPlatformConfig = process.argv[2] ?? process.env.DSH_DESKTOP_OPERATED_PLATFORM_CONFIG
if (operatedPlatformConfig === undefined || operatedPlatformConfig.trim() === '') {
  throw new TypeError('Desktop build requires an operated Platform configuration path')
}
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
  external: ['electron', 'electron-updater', 'ws'],
  logLevel: 'info',
})
await cp(join(root, 'src', 'preload.cjs'), join(root, 'out', 'preload.cjs'))
await writeFile(
  join(root, 'out', 'operated-platform.json'),
  JSON.stringify(publicOperatedPlatformConfig, undefined, 2) + '\n',
)
await mkdir(join(root, 'out', 'build'), { recursive: true })
await cp(join(root, 'build', 'icon.png'), join(root, 'out', 'build', 'icon.png'))

function parseOperatedPlatformConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop operated Platform configuration must be an object')
  }
  const fields = [
    'environment',
    'origin', 'callbackUrl', 'githubClientId', 'credentialReference', 'databaseIdentity', 'identityNamespace',
  ]
  const unknown = Object.keys(value).filter(field => !fields.includes(field))
  if (unknown.length > 0) {
    throw new TypeError(`Desktop operated Platform configuration contains unknown fields: ${unknown.join(', ')}`)
  }
  if (value.environment !== 'production') {
    throw new TypeError('Desktop operated Platform configuration requires environment production')
  }
  for (const field of fields.slice(1)) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new TypeError(`Desktop operated Platform configuration requires ${field}`)
    }
  }
  return {
    environment: 'production',
    origin: value.origin,
    callbackUrl: value.callbackUrl,
    githubClientId: value.githubClientId,
    credentialReference: value.credentialReference,
    databaseIdentity: value.databaseIdentity,
    identityNamespace: value.identityNamespace,
  }
}
