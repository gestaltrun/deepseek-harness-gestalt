import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  verifyWindowsUpdateFeed, verifyWindowsUpdateFeedOverHttp, withStaticReleaseServer,
} from '../scripts/verify-windows-update-feed.mjs'

const installer = Buffer.from('nsis-installer')
const sha512 = createHash('sha512').update(installer).digest('base64')

function feedText(overrides: Record<string, string> = {}): string {
  const values = {
    version: '0.1.6',
    url: 'DeepSeekGestalt-Setup-0.1.6-x64.exe',
    sha512,
    size: String(installer.length),
    path: 'DeepSeekGestalt-Setup-0.1.6-x64.exe',
    ...overrides,
  }
  return [
    `version: ${values.version}`,
    'files:',
    `  - url: ${values.url}`,
    `    sha512: ${values.sha512}`,
    `    size: ${values.size}`,
    `path: ${values.path}`,
    `sha512: ${values.sha512}`,
    "releaseDate: '2026-08-25T14:31:35.332Z'",
    '',
  ].join('\n')
}

async function writeRelease(dir: string, yml: string, bytes: Buffer = installer): Promise<string> {
  const root = join(dir, 'release')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'latest.yml'), yml)
  await writeFile(join(root, 'DeepSeekGestalt-Setup-0.1.6-x64.exe'), bytes)
  return root
}

describe('verifyWindowsUpdateFeed', () => {
  it('accepts a latest.yml that matches the NSIS installer and rejects a checksum drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-win-feed-'))
    const root = await writeRelease(dir, feedText())
    await expect(verifyWindowsUpdateFeed({ releaseDir: root, version: '0.1.6' })).resolves.toMatchObject({
      feed: { version: '0.1.6', size: installer.length, sha512 },
    })

    const drifted = await writeRelease(join(dir, 'bad'), feedText({ sha512: 'AAAA' }))
    await expect(verifyWindowsUpdateFeed({ releaseDir: drifted, version: '0.1.6' })).rejects.toThrow('sha512')
  })

  it('rejects a path or size that does not name the versioned NSIS installer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-win-feed-name-'))
    const wrongName = await writeRelease(dir, feedText({ path: 'Setup.exe', url: 'Setup.exe' }))
    await expect(verifyWindowsUpdateFeed({ releaseDir: wrongName, version: '0.1.6' })).rejects.toThrow('path')
    const wrongSize = await writeRelease(join(dir, 'size'), feedText({ size: '1' }))
    await expect(verifyWindowsUpdateFeed({ releaseDir: wrongSize, version: '0.1.6' })).rejects.toThrow('size')
  })

  it('downloads the feed over loopback the way electron-updater reads latest.yml then the exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-win-feed-http-'))
    const root = await writeRelease(dir, feedText())
    await withStaticReleaseServer(root, origin => verifyWindowsUpdateFeedOverHttp({
      rootUrl: origin,
      version: '0.1.6',
      sha512,
      size: installer.length,
    }))
  })
})
