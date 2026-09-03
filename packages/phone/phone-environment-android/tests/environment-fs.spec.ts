import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsControls = vi.hoisted(() => ({
  statfs: vi.fn(),
  lstatSync: vi.fn(),
  renameSync: vi.fn(),
  actualLstatSync: undefined as typeof import('node:fs').lstatSync | undefined,
  actualRenameSync: undefined as typeof import('node:fs').renameSync | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  fsControls.statfs.mockImplementation(original.statfs)
  return { ...original, statfs: fsControls.statfs }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  fsControls.actualLstatSync = original.lstatSync
  fsControls.actualRenameSync = original.renameSync
  return { ...original, lstatSync: fsControls.lstatSync, renameSync: fsControls.renameSync }
})

import { AndroidEnvironmentManager } from '../src/environment.ts'

const roots: string[] = []

beforeEach(() => {
  fsControls.statfs.mockReset()
  fsControls.lstatSync.mockReset().mockImplementation(fsControls.actualLstatSync!)
  fsControls.renameSync.mockReset().mockImplementation(fsControls.actualRenameSync!)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-android-fs-'))
  roots.push(root)
  return root
}

function manager(root: string, removalRaceHook?: (path: string) => Promise<void>): AndroidEnvironmentManager {
  return new AndroidEnvironmentManager({
    phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: {}, homeDirectory: root,
    ...(removalRaceHook === undefined ? {} : { removalRaceHook }),
  })
}

function internals(value: AndroidEnvironmentManager): {
  freeBytes(path: string): Promise<number>
  removePath(path: string, recursive: boolean): Promise<void>
} {
  return value as unknown as {
    freeBytes(path: string): Promise<number>
    removePath(path: string, recursive: boolean): Promise<void>
  }
}

describe('Android environment filesystem facts', () => {
  it('clamps a filesystem capacity that exceeds safe integer precision', async () => {
    const root = await tempRoot()
    fsControls.statfs.mockResolvedValue({ bavail: BigInt(Number.MAX_SAFE_INTEGER), bsize: 2n })
    await expect(internals(manager(root)).freeBytes(root)).resolves.toBe(Number.MAX_SAFE_INTEGER)
  })

  it('propagates a filesystem error other than a missing path', async () => {
    const root = await tempRoot()
    fsControls.statfs.mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }))
    await expect(internals(manager(root)).freeBytes(root)).rejects.toThrow('access denied')
  })

  it('propagates ENOENT after reaching the filesystem root', async () => {
    const root = await tempRoot()
    fsControls.statfs.mockRejectedValue(Object.assign(new Error('root missing'), { code: 'ENOENT' }))
    await expect(internals(manager(root)).freeBytes('/')).rejects.toThrow('root missing')
  })

  it('propagates a link inspection failure other than ENOENT', async () => {
    const root = await tempRoot()
    fsControls.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('inspection denied'), { code: 'EACCES' })
    })
    await expect(internals(manager(root)).removePath(join(root, 'target'), true)).rejects.toThrow('inspection denied')
  })

  it('retries an ENOENT rename and rejects a different rename failure', async () => {
    const root = await tempRoot()
    const target = join(root, 'target')
    await mkdir(target)
    fsControls.renameSync.mockImplementation(() => {
      throw Object.assign(new Error('replaced'), { code: 'ENOENT' })
    })
    await expect(internals(manager(root)).removePath(target, true)).rejects.toThrow(/changed during cleanup/u)

    fsControls.renameSync.mockImplementation(() => {
      throw Object.assign(new Error('rename denied'), { code: 'EACCES' })
    })
    await expect(internals(manager(root)).removePath(target, true)).rejects.toThrow('rename denied')
  })

  it('unlinks a cleanup entry replaced by a symlink without following it', async () => {
    const root = await tempRoot()
    const target = join(root, 'target')
    const external = join(root, 'external')
    await mkdir(target)
    await mkdir(external)
    await writeFile(join(external, 'keep'), 'owned elsewhere')
    const value = manager(root, async () => {
      const quarantine = (await readdir(root)).find(name => name.startsWith('.dsh-avd-cleanup-'))
      if (quarantine === undefined) throw new Error('cleanup quarantine was not created')
      const moved = join(root, quarantine, 'entry')
      await rm(moved, { recursive: true })
      await symlink(external, moved)
    })
    await expect(internals(value).removePath(target, true)).resolves.toBeUndefined()
    await expect(writeFile(join(external, 'still-writable'), 'yes')).resolves.toBeUndefined()
  })
})
