import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const interception = vi.hoisted(() => ({
  beforeLstat: undefined as (() => Promise<void>) | undefined,
  beforeOpen: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const intercept = interception.beforeLstat
      interception.beforeLstat = undefined
      await intercept?.()
      return actual.lstat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const intercept = interception.beforeOpen
      interception.beforeOpen = undefined
      await intercept?.()
      return actual.open(...args)
    },
  }
})

import { validateRoutedReferences } from '../src/references.ts'

const roots: string[] = []

afterEach(async () => {
  interception.beforeLstat = undefined
  interception.beforeOpen = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('routed reference identity', () => {
  it('rejects a target replaced by an outside symlink between validation and open', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-ask-user-reference-race-'))
    roots.push(parent)
    const workspace = join(parent, 'workspace')
    const target = join(workspace, 'decision.md')
    const retained = join(workspace, 'decision-original.md')
    const outside = join(parent, 'outside.md')
    await mkdir(workspace)
    await writeFile(target, 'inside\n')
    await writeFile(outside, 'outside\n')
    interception.beforeOpen = async () => {
      await rename(target, retained)
      await symlink(outside, target)
    }

    await expect(validateRoutedReferences([{ path: 'decision.md' }], workspace)).rejects.toMatchObject({
      name: 'AskUserQuestionError',
      code: 'REFERENCES_INVALID',
    })
  })

  it('rejects an outside symlink installed after realpath and before the final-path check', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-ask-user-reference-lstat-race-'))
    roots.push(parent)
    const workspace = join(parent, 'workspace')
    const target = join(workspace, 'decision.md')
    const retained = join(workspace, 'decision-original.md')
    const outside = join(parent, 'outside.md')
    await mkdir(workspace)
    await writeFile(target, 'inside\n')
    await writeFile(outside, 'outside\n')
    interception.beforeLstat = async () => {
      await rename(target, retained)
      await symlink(outside, target)
    }

    await expect(validateRoutedReferences([{ path: 'decision.md' }], workspace)).rejects.toMatchObject({
      name: 'AskUserQuestionError',
      code: 'REFERENCES_INVALID',
      message: 'REFERENCES_INVALID: references[0]: path "decision.md" changed while being validated',
    })
  })

  it('rejects a regular file replacement between the final-path check and descriptor validation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-ask-user-reference-file-race-'))
    roots.push(parent)
    const workspace = join(parent, 'workspace')
    const target = join(workspace, 'decision.md')
    const retained = join(workspace, 'decision-original.md')
    const replacement = join(parent, 'replacement.md')
    await mkdir(workspace)
    await writeFile(target, 'inside\n')
    await writeFile(replacement, 'replacement\n')
    interception.beforeOpen = async () => {
      await rename(target, retained)
      await rename(replacement, target)
    }

    await expect(validateRoutedReferences([{ path: 'decision.md' }], workspace)).rejects.toMatchObject({
      name: 'AskUserQuestionError',
      code: 'REFERENCES_INVALID',
      message: 'REFERENCES_INVALID: references[0]: path "decision.md" changed while being validated',
    })
  })
})
