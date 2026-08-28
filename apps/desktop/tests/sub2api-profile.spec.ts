import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addSub2ApiBundleRow,
  bundlePackageExists,
  installedBundleVersion,
  isOwnDisableRow,
  isSub2ApiDisabled,
  manifestListsBundle,
  manifestWithBundle,
  manifestWithoutBundle,
  patchRowsWithDisable,
  patchRowsWithoutDisable,
  readProfileManifestText,
  readSub2ApiProfileManifest,
  removeBundlePackage,
  removeSub2ApiBundleRow,
  restoreSub2ApiProfileManifest,
  setSub2ApiDisabled,
  SUB2API_BUNDLE_NAME,
  SUB2API_ROW_ID,
  targetsRow,
  type Sub2ApiProfileManifest,
} from '../src/sub2api-profile.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function profileDir(manifest: object, patch?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sub2api-profile-'))
  dirs.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

function manifest(bundles: string[]): Sub2ApiProfileManifest {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@deepseek-ai/dsh-base': '*' },
    dsh: { profile: { bundles: [...bundles] } },
  }
}

describe('manifest bundle-row transforms', () => {
  it('appends the bundle without touching other entries, and is idempotent', () => {
    const base = manifest(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const patched = manifestWithBundle(base, SUB2API_BUNDLE_NAME)
    expect(patched.dsh?.profile?.bundles)
      .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', SUB2API_BUNDLE_NAME])
    expect(patched.dependencies).toEqual(base.dependencies)
    expect(patched.name).toBe(base.name)
    expect(manifestListsBundle(patched, SUB2API_BUNDLE_NAME)).toBe(true)
    expect(manifestWithBundle(patched, SUB2API_BUNDLE_NAME)).toBe(patched)
    expect(manifestListsBundle(manifest(['x']), SUB2API_BUNDLE_NAME)).toBe(false)
    expect(({} as Sub2ApiProfileManifest).dsh?.profile?.bundles).toBeUndefined()
  })

  it('removes only the bundle row', () => {
    const base = manifestWithBundle(manifest(['a', 'b']), SUB2API_BUNDLE_NAME)
    const removed = manifestWithoutBundle(base, SUB2API_BUNDLE_NAME)
    expect(removed.dsh?.profile?.bundles).toEqual(['a', 'b'])
    expect(manifestWithoutBundle(removed, SUB2API_BUNDLE_NAME)).toBe(removed)
    expect(manifestWithoutBundle(manifest([]), SUB2API_BUNDLE_NAME).dsh?.profile?.bundles).toEqual([])
  })
})

describe('profile manifest row persistence', () => {
  it('adds and removes the row through the real manifest on disk', async () => {
    const dir = await profileDir(manifest(['@deepseek-ai/dsh-base']))
    expect(await addSub2ApiBundleRow(dir)).toBe(true)
    expect(await addSub2ApiBundleRow(dir)).toBe(false)
    expect(manifestListsBundle(await readSub2ApiProfileManifest(dir), SUB2API_BUNDLE_NAME)).toBe(true)
    // Unrelated manifest fields survive the round trip byte-value-identical.
    const onDisk = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Sub2ApiProfileManifest
    expect(onDisk.dependencies).toEqual({ '@deepseek-ai/dsh-base': '*' })
    expect(onDisk['private']).toBe(true)

    expect(await removeSub2ApiBundleRow(dir)).toBe(true)
    expect(await removeSub2ApiBundleRow(dir)).toBe(false)
    expect(manifestListsBundle(await readSub2ApiProfileManifest(dir), SUB2API_BUNDLE_NAME)).toBe(false)
  })

  it('fails loud when the manifest is missing or not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sub2api-profile-'))
    dirs.push(dir)
    await expect(readSub2ApiProfileManifest(dir)).rejects.toThrow('unreadable')

    await writeFile(join(dir, 'package.json'), '{bad')
    await expect(readSub2ApiProfileManifest(dir)).rejects.toThrow('not valid JSON')

    await writeFile(join(dir, 'package.json'), '[1]')
    await expect(readSub2ApiProfileManifest(dir)).rejects.toThrow('must hold a JSON object')
  })
})

describe('profile patch-layer disable row', () => {
  it('writes, detects, and removes the exact disable row', async () => {
    const dir = await profileDir(manifest(['@deepseek-ai/dsh-base']), '[]\n')
    expect(await isSub2ApiDisabled(dir)).toBe(false)
    await setSub2ApiDisabled(dir, true)
    expect(await isSub2ApiDisabled(dir)).toBe(true)
    await setSub2ApiDisabled(dir, true) // idempotent
    await setSub2ApiDisabled(dir, false)
    expect(await isSub2ApiDisabled(dir)).toBe(false)
    await setSub2ApiDisabled(dir, false) // idempotent
    const onDisk = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(onDisk.trim()).toBe('[]')
  })

  it('creates the patch file when the profile has no user layer', async () => {
    const dir = await profileDir(manifest(['@deepseek-ai/dsh-base']))
    await setSub2ApiDisabled(dir, true)
    expect(await isSub2ApiDisabled(dir)).toBe(true)
  })

  it('refuses to disable when a user-owned row patches the same id', async () => {
    const userLayer = '- id: dsh-sub2api-sidecar\n  config:\n    enabled: false\n'
    const dir = await profileDir(manifest(['@deepseek-ai/dsh-base']), userLayer)
    await expect(setSub2ApiDisabled(dir, true)).rejects.toThrow("already patches the 'dsh-sub2api-sidecar' row")
    // Removal still works: it only ever touches the installer-owned row.
    await setSub2ApiDisabled(dir, false)
  })

  it('round-trips !!js expressions in the user layer through the entry dialect', async () => {
    const userLayer = '- id: web-runtime\n  config:\n    printUrl: !!js process.env.DSH_PRINT != null\n'
    const dir = await profileDir(manifest(['@deepseek-ai/dsh-base']), userLayer)
    await setSub2ApiDisabled(dir, true)
    const text = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('!!js process.env.DSH_PRINT != null')
    expect(text).toContain('id: dsh-sub2api-sidecar')
    await setSub2ApiDisabled(dir, false)
    const restored = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(restored).not.toContain('dsh-sub2api-sidecar')
    expect(restored).toContain('process.env.DSH_PRINT')
  })
})

describe('patch-row predicates', () => {
  it('distinguish the installer-owned disable row from user rows', () => {
    const row = { id: SUB2API_ROW_ID, disabled: true }
    expect(isOwnDisableRow(row, SUB2API_ROW_ID)).toBe(true)
    expect(isOwnDisableRow({ id: SUB2API_ROW_ID, disabled: true, config: {} }, SUB2API_ROW_ID)).toBe(false)
    expect(isOwnDisableRow({ id: SUB2API_ROW_ID }, SUB2API_ROW_ID)).toBe(false)
    expect(isOwnDisableRow({ id: 'other', disabled: true }, SUB2API_ROW_ID)).toBe(false)
    expect(isOwnDisableRow(['row'], SUB2API_ROW_ID)).toBe(false)
    expect(targetsRow(row, SUB2API_ROW_ID)).toBe(true)
    expect(targetsRow('string', SUB2API_ROW_ID)).toBe(false)
    expect(targetsRow(['row'], SUB2API_ROW_ID)).toBe(false)
    expect(patchRowsWithDisable([row], SUB2API_ROW_ID)).toEqual([row])
    expect(patchRowsWithDisable([], SUB2API_ROW_ID)).toEqual([row])
    expect(patchRowsWithoutDisable([{ id: 'x' }, row], SUB2API_ROW_ID)).toEqual([{ id: 'x' }])
  })
})

describe('degenerate manifest and patch shapes', () => {
  it('treats a dsh section without bundles as an empty list', () => {
    const base: Sub2ApiProfileManifest = { name: 'dsh-profile-web', dsh: { profile: {} } }
    const patched = manifestWithBundle(base, SUB2API_BUNDLE_NAME)
    expect(patched.dsh?.profile?.bundles).toEqual([SUB2API_BUNDLE_NAME])
    expect(manifestWithoutBundle(base, SUB2API_BUNDLE_NAME)).toBe(base)
  })

  it('rejects a patch layer that is unparseable or not an array', async () => {
    const broken = await profileDir(manifest([]), '- id: [unclosed\n')
    await expect(setSub2ApiDisabled(broken, true)).rejects.toThrow('does not parse')

    const scalar = await profileDir(manifest([]), 'just a scalar\n')
    await expect(setSub2ApiDisabled(scalar, true)).rejects.toThrow('must be a top-level YAML array')
  })

  it('reports a non-string version as absent', async () => {
    const dir = await profileDir(manifest([]))
    const { mkdir, writeFile: writeFileFn } = await import('node:fs/promises')
    const packageDir = join(dir, 'node_modules', SUB2API_BUNDLE_NAME)
    await mkdir(packageDir, { recursive: true })
    await writeFileFn(join(packageDir, 'package.json'), JSON.stringify({ name: SUB2API_BUNDLE_NAME, version: 42 }))
    expect(await installedBundleVersion(dir)).toBeUndefined()
  })

  it('restores an exact prior manifest document', async () => {
    const dir = await profileDir(manifest(['a']))
    const before = await readProfileManifestText(dir)
    await addSub2ApiBundleRow(dir)
    expect(await readProfileManifestText(dir)).not.toBe(before)
    await restoreSub2ApiProfileManifest(dir, before)
    expect(await readProfileManifestText(dir)).toBe(before)
  })
})

describe('installed bundle inspection', () => {
  it('reads the version from the extracted package and tolerates its absence', async () => {
    const dir = await profileDir(manifest([]))
    expect(await installedBundleVersion(dir)).toBeUndefined()
    expect(await bundlePackageExists(dir)).toBe(false)

    const packageDir = join(dir, 'node_modules', SUB2API_BUNDLE_NAME)
    await rm(packageDir, { recursive: true, force: true })
    const { mkdir, writeFile: writeFileFn } = await import('node:fs/promises')
    await mkdir(packageDir, { recursive: true })
    await writeFileFn(join(packageDir, 'package.json'), JSON.stringify({ name: SUB2API_BUNDLE_NAME, version: '0.2.0' }))
    expect(await installedBundleVersion(dir)).toBe('0.2.0')
    expect(await bundlePackageExists(dir)).toBe(true)

    await removeBundlePackage(dir)
    expect(await bundlePackageExists(dir)).toBe(false)
    expect(await installedBundleVersion(dir)).toBeUndefined()
  })

  it('returns undefined for an unparseable installed manifest', async () => {
    const dir = await profileDir(manifest([]))
    const { mkdir, writeFile: writeFileFn } = await import('node:fs/promises')
    const packageDir = join(dir, 'node_modules', SUB2API_BUNDLE_NAME)
    await mkdir(packageDir, { recursive: true })
    await writeFileFn(join(packageDir, 'package.json'), '{bad')
    expect(await installedBundleVersion(dir)).toBeUndefined()
  })
})
