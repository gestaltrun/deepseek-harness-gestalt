#!/usr/bin/env node
/** Prove Windows latest.yml names, sizes, and sha512 match the NSIS installer. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'

/**
 * Parse electron-builder's Windows latest.yml.
 * @param {string} text - feed body.
 * @returns {{ version: string, path: string, sha512: string, size: number, url: string }}
 */
export function parseWindowsLatestYml(text) {
  const version = unindentedField(text, 'version')
  const path = unindentedField(text, 'path')
  const sha512 = unindentedField(text, 'sha512')
  const url = indentedField(text, 'url')
  const sizeText = indentedField(text, 'size')
  if (version === undefined) throw new Error('latest.yml is missing version')
  if (path === undefined) throw new Error('latest.yml is missing path')
  if (sha512 === undefined) throw new Error('latest.yml is missing sha512')
  if (url === undefined) throw new Error('latest.yml is missing files.url')
  if (sizeText === undefined) throw new Error('latest.yml is missing files.size')
  const size = Number(sizeText)
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`latest.yml files.size is not a positive integer: ${sizeText}`)
  }
  return { version, path, sha512, size, url }
}

/**
 * Require latest.yml and the NSIS installer to agree on name, size, and sha512.
 * @param {{ releaseDir: string, version: string }} input - packaged Windows output.
 * @returns {Promise<{ installer: string, feed: ReturnType<typeof parseWindowsLatestYml> }>}
 */
export async function verifyWindowsUpdateFeed(input) {
  const releaseDir = resolve(input.releaseDir)
  const feedPath = join(releaseDir, 'latest.yml')
  const feed = parseWindowsLatestYml(await readFile(feedPath, 'utf8'))
  const expectedName = `DeepSeekGestalt-Setup-${input.version}-x64.exe`
  if (feed.version !== input.version) {
    throw new Error(`latest.yml version ${feed.version} does not match ${input.version}`)
  }
  if (feed.path !== expectedName) {
    throw new Error(`latest.yml path ${feed.path} does not match ${expectedName}`)
  }
  if (feed.url !== expectedName) {
    throw new Error(`latest.yml files.url ${feed.url} does not match ${expectedName}`)
  }
  const installer = join(releaseDir, expectedName)
  const bytes = await stat(installer)
  if (bytes.size !== feed.size) {
    throw new Error(`installer size ${String(bytes.size)} does not match latest.yml ${String(feed.size)}`)
  }
  const digest = await sha512File(installer)
  if (digest !== feed.sha512) {
    throw new Error(`installer sha512 ${digest} does not match latest.yml ${feed.sha512}`)
  }
  return { installer, feed }
}

/**
 * Download latest.yml and the NSIS installer from a loopback feed and re-check sha512.
 * @param {{ rootUrl: string, version: string, sha512: string, size: number }} input - served feed.
 * @returns {Promise<void>}
 */
export async function verifyWindowsUpdateFeedOverHttp(input) {
  const yml = await (await fetch(new URL('latest.yml', input.rootUrl))).text()
  const feed = parseWindowsLatestYml(yml)
  if (feed.version !== input.version) {
    throw new Error(`HTTP latest.yml version ${feed.version} does not match ${input.version}`)
  }
  if (feed.sha512 !== input.sha512 || feed.size !== input.size) {
    throw new Error('HTTP latest.yml checksum or size does not match the local installer')
  }
  const res = await fetch(new URL(feed.path, input.rootUrl))
  if (!res.ok || res.body === null) {
    throw new Error(`HTTP installer download failed: ${String(res.status)}`)
  }
  const digest = createHash('sha512')
  let n = 0
  for await (const chunk of res.body) {
    n += chunk.length
    digest.update(chunk)
  }
  if (n !== input.size) {
    throw new Error(`HTTP installer size ${String(n)} does not match ${String(input.size)}`)
  }
  const actual = digest.digest('base64')
  if (actual !== input.sha512) {
    throw new Error(`HTTP installer sha512 ${actual} does not match ${input.sha512}`)
  }
}

/**
 * Serve a directory of release files on loopback until the callback finishes.
 * @param {string} root - directory to serve.
 * @param {(origin: string) => Promise<void>} run - work against the origin.
 * @returns {Promise<void>}
 */
export async function withStaticReleaseServer(root, run) {
  const server = createServer((req, res) => {
    const name = basename(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (name.length === 0 || name !== basename(name)) {
      res.statusCode = 400
      res.end()
      return
    }
    const file = join(root, name)
    const stream = createReadStream(file)
    stream.on('error', () => {
      res.statusCode = 404
      res.end()
    })
    stream.pipe(res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('loopback release server did not bind a port')
  }
  try {
    await run(`http://127.0.0.1:${String(address.port)}/`)
  } finally {
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }
}

/** @param {string} path @returns {Promise<string>} */
async function sha512File(path) {
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('base64')
}

/** @param {string} text @param {string} key @returns {string | undefined} */
function unindentedField(text, key) {
  return new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(text)?.[1]
}

/** @param {string} text @param {string} key @returns {string | undefined} */
function indentedField(text, key) {
  return new RegExp(`^[ \\t]+(?:- )?${key}:\\s*(\\S+)\\s*$`, 'm').exec(text)?.[1]
}

if (process.argv[1]?.endsWith('verify-windows-update-feed.mjs') === true) {
  const releaseDir = process.argv[2]
  const version = process.argv[3]
  if (releaseDir === undefined || version === undefined) {
    throw new Error('usage: verify-windows-update-feed.mjs <release-dir> <version>')
  }
  const { feed } = await verifyWindowsUpdateFeed({ releaseDir, version })
  await withStaticReleaseServer(releaseDir, origin => verifyWindowsUpdateFeedOverHttp({
    rootUrl: origin,
    version,
    sha512: feed.sha512,
    size: feed.size,
  }))
  console.log(`windows update feed ${version} sha512=${feed.sha512} size=${String(feed.size)}`)
}
