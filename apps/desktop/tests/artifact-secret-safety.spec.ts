import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertArtifactSecretsAbsent, credentialValues } from '../scripts/artifact-secret-safety.mjs'

describe('Sub2API artifact secret safety', () => {
  it('collects every copied credential value', () => {
    expect(credentialValues({
      refs: { first: 'secret-one', second: 'secret-two' },
      nested: [{ value: 'secret-three' }],
      empty: '',
    })).toEqual(expect.arrayContaining(['secret-one', 'secret-two', 'secret-three']))
  })

  it('rejects an artifact containing any copied credential value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-artifact-secret-'))
    try {
      await mkdir(join(root, 'nested'))
      await writeFile(join(root, 'safe.log'), 'safe diagnostic')
      await writeFile(join(root, 'nested', 'leak.log'), 'prefix secret-two suffix')

      await expect(assertArtifactSecretsAbsent(root, ['secret-one', 'secret-two', 'secret-three']))
        .rejects.toThrow('leak.log')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
