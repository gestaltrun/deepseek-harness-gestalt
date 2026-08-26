import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../src/git.ts'

describe('repository selection', () => {
  it('rejects an explicit repository that is not among the discovered roots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-'))
    try {
      const repository = join(directory, 'repository')
      mkdirSync(repository)
      execFileSync('git', ['init', '--quiet', repository])

      await expect(repoRoot(directory, join(directory, 'missing'))).rejects.toMatchObject({
        code: 'unknown-repository',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
