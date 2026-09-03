/**
 * Write `out/sub2api-sources.json` from the approved per-os/arch catalog.
 *
 * The catalog is deployment configuration. A missing platform entry omits the
 * file so enablement keeps the placeholder error instead of substituting
 * another architecture.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_FIELDS = [
  'bundleUrl',
  'bundleSha256SumsUrl',
  'runtimePackUrl',
  'runtimePackSha256SumsUrl',
]

/**
 * @param {{ root: string, platform: string, arch: string }} options
 * @returns {Promise<void>}
 */
export async function writePackagedSub2ApiSources(options) {
  const catalog = parseCatalog(JSON.parse(
    await readFile(join(options.root, 'sub2api-sources.catalog.json'), 'utf8'),
  ))
  const outDir = join(options.root, 'out')
  const artifact = join(outDir, 'sub2api-sources.json')
  const entry = catalog[`${options.platform}-${options.arch}`]
  if (entry === undefined) {
    await rm(artifact, { force: true })
    return
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(artifact, JSON.stringify(entry, undefined, 2) + '\n')
}

function parseCatalog(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop Sub2API source catalog must be a JSON object')
  }
  /** @type {Record<string, ReturnType<typeof parseSources>>} */
  const catalog = {}
  for (const [key, entry] of Object.entries(value)) {
    catalog[key] = parseSources(entry, key)
  }
  return catalog
}

function parseSources(value, key) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Desktop Sub2API source catalog entry ${key} must be a JSON object`)
  }
  const unknown = Object.keys(value).filter(field => !REQUIRED_FIELDS.includes(field))
  if (unknown.length > 0) {
    throw new TypeError(`Desktop Sub2API source catalog entry ${key} contains unknown fields: ${unknown.join(', ')}`)
  }
  return {
    bundleUrl: requireHttpsUrl(value.bundleUrl, key, 'bundleUrl'),
    bundleSha256SumsUrl: requireHttpsUrl(value.bundleSha256SumsUrl, key, 'bundleSha256SumsUrl'),
    runtimePackUrl: requireHttpsUrl(value.runtimePackUrl, key, 'runtimePackUrl'),
    runtimePackSha256SumsUrl: requireHttpsUrl(value.runtimePackSha256SumsUrl, key, 'runtimePackSha256SumsUrl'),
  }
}

function requireHttpsUrl(value, key, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Desktop Sub2API source catalog entry ${key} requires ${field} as a non-empty string`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`Desktop Sub2API source catalog entry ${key} field ${field} is not an absolute URL: ${value}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new TypeError(`Desktop Sub2API source catalog entry ${key} field ${field} must be an https URL: ${value}`)
  }
  return value
}

const invoked = process.argv[1] !== undefined && process.argv[1].endsWith('write-sub2api-sources.mjs')
if (invoked) {
  const args = process.argv.slice(2).filter(value => value !== '--')
  const here = dirname(fileURLToPath(import.meta.url))
  await writePackagedSub2ApiSources({
    root: join(here, '..'),
    platform: flag('--platform', args) ?? process.env.DSH_DESKTOP_SUB2API_PLATFORM ?? process.platform,
    arch: flag('--arch', args) ?? process.env.DSH_DESKTOP_SUB2API_ARCH ?? process.arch,
  })
}

function flag(name, argv) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
