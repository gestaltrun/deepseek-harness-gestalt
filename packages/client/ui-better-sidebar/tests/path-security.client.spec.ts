/** Read-side path resolution for explicit opens outside the session workspace. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureWorkspacePath, resolveReadablePath } from '../src/path-security.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-paths-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveReadablePath', () => {
  it('resolves an existing file outside any workspace through symlinks', async () => {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const target = join(root, 'note.md')
    await writeFile(target, 'hi')
    const link = join(root, 'linked.md')
    await symlink(target, link)

    await expect(resolveReadablePath(target)).resolves.toBe(await realpath(target))
    await expect(resolveReadablePath(link)).resolves.toBe(await realpath(link))
    await expect(ensureWorkspacePath(workspace, target)).rejects.toThrow(/outside workspace/)
    await expect(resolveReadablePath(join(root, 'missing.md'))).rejects.toThrow(/cannot resolve/)
    await expect(resolveReadablePath('relative.md')).rejects.toThrow()
  })
})
