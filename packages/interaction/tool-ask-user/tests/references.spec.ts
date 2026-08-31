import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REFERENCES_MAX_COUNT, validateReferences } from '@deepseek-ai/dsh-tool-ask-user'

function workspaceFixture(): { workspace: string; inside: string } {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-ask-user-validate-refs-'))
  const workspace = join(parent, 'ws')
  mkdirSync(workspace)
  const inside = join(workspace, 'inside.md')
  writeFileSync(inside, 'ok\n')
  mkdirSync(join(workspace, 'nested'))
  writeFileSync(join(parent, 'outside.md'), 'secret\n')
  return { workspace, inside }
}

async function expectInvalid(
  references: Parameters<typeof validateReferences>[0],
  workspaceRoot: string | undefined,
  message: string,
): Promise<void> {
  await expect(validateReferences(references, workspaceRoot)).rejects.toMatchObject({
    name: 'AskUserQuestionError',
    code: 'REFERENCES_INVALID',
    message,
  })
}

describe('validateReferences', () => {
  it('returns undefined when the model omits references', async () => {
    await expect(validateReferences(undefined, workspaceFixture().workspace)).resolves.toBeUndefined()
  })

  it('returns a canonical relative path without reading transfer bytes or inventing a reason', async () => {
    const { workspace } = workspaceFixture()
    const result = await validateReferences([{ path: 'inside.md' }], workspace)
    expect(result).toHaveLength(1)
    expect(result?.[0]).toMatchObject({ path: 'inside.md' })
    expect(result?.[0]?.reason).toBeUndefined()
    expect(result?.[0]).not.toHaveProperty('bytes')
  })

  it('canonicalizes an absolute workspace file path and retains its reason', async () => {
    const { workspace, inside } = workspaceFixture()
    const result = await validateReferences(
      [{ path: inside, reason: 'Rollout plan' }],
      workspace,
    )
    expect(result).toHaveLength(1)
    expect(result?.[0]).toMatchObject({ path: 'inside.md', reason: 'Rollout plan' })
    expect(result?.[0]).not.toHaveProperty('bytes')
  })

  it('rejects more than REFERENCES_MAX_COUNT items', async () => {
    const { workspace } = workspaceFixture()
    await expectInvalid(
      Array.from({ length: REFERENCES_MAX_COUNT + 1 }, () => ({ path: 'inside.md' })),
      workspace,
      `REFERENCES_INVALID: references exceeds the ceiling of ${String(REFERENCES_MAX_COUNT)} items`,
    )
  })

  it('rejects an empty path', async () => {
    const { workspace } = workspaceFixture()
    await expectInvalid(
      [{ path: '' }],
      workspace,
      'REFERENCES_INVALID: references[0]: path must be a non-empty string',
    )
  })

  it('rejects a path when the asking session has no workspace', async () => {
    await expectInvalid(
      [{ path: 'inside.md' }],
      undefined,
      'REFERENCES_INVALID: references[0]: path "inside.md" cannot be resolved without a session workspace',
    )
  })

  it('rejects a workspace that cannot be resolved', async () => {
    const { workspace } = workspaceFixture()
    const missing = join(workspace, 'missing-root')
    await expectInvalid(
      [{ path: 'inside.md' }],
      missing,
      `REFERENCES_INVALID: references[0]: workspace ${JSON.stringify(missing)} is unreadable`,
    )
  })

  it('rejects a file that exists outside the workspace', async () => {
    const { workspace } = workspaceFixture()
    await expectInvalid(
      [{ path: '../outside.md' }],
      workspace,
      'REFERENCES_INVALID: references[0]: path "../outside.md" is outside the session workspace',
    )
  })

  it('rejects a path that resolves to the workspace parent', async () => {
    const { workspace } = workspaceFixture()
    await expectInvalid(
      [{ path: '..' }],
      workspace,
      'REFERENCES_INVALID: references[0]: path ".." is outside the session workspace',
    )
  })

  it('rejects a directory', async () => {
    const { workspace } = workspaceFixture()
    await expectInvalid(
      [{ path: 'nested' }],
      workspace,
      'REFERENCES_INVALID: references[0]: path "nested" is not a file',
    )
  })

  it('rejects an empty reason', async () => {
    const { workspace } = workspaceFixture()
    await expectInvalid(
      [{ path: 'inside.md', reason: '' }],
      workspace,
      'REFERENCES_INVALID: references[0]: reason must contain 1-100 code points',
    )
  })
})
