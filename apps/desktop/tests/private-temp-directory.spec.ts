import { access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withPrivateTempDirectory } from '../scripts/private-temp-directory.mjs'

describe('withPrivateTempDirectory', () => {
  it('removes credential-bearing setup state when the operation fails', async () => {
    let runRoot = ''
    await expect(withPrivateTempDirectory(join(tmpdir(), 'dsh-private-dir-'), async (directory) => {
      runRoot = directory
      await writeFile(join(directory, '.credentials.yaml'), 'fake-credential')
      throw new Error('setup exploded')
    })).rejects.toThrow('setup exploded')
    await expect(access(runRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
