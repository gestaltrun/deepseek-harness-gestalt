import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { REFERENCES_MAX_COUNT, validateReferences, validateRoutedReferences } from '@deepseek-ai/dsh-tool-ask-user'

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

  it('keeps a relative file path and omits an absent reason', async () => {
    const { workspace } = workspaceFixture()
    await expect(validateReferences([{ path: 'inside.md' }], workspace)).resolves.toEqual([
      { path: 'inside.md' },
    ])
  })

  it('keeps an absolute workspace file path and a supplied reason', async () => {
    const { workspace, inside } = workspaceFixture()
    await expect(validateReferences(
      [{ path: inside, reason: 'Rollout plan' }],
      workspace,
    )).resolves.toEqual([
      { path: inside, reason: 'Rollout plan' },
    ])
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

describe('validateRoutedReferences', () => {
  it('reads admitted file bytes for a routed ask', async () => {
    const { workspace, inside } = workspaceFixture()
    await expect(validateRoutedReferences([{ path: 'inside.md' }], workspace)).resolves.toEqual({
      references: [{ path: 'inside.md' }],
      documents: [{ path: 'inside.md', bytes: new Uint8Array(Buffer.from('ok\n')) }],
    })
    await expect(validateRoutedReferences([{ path: inside, reason: 'Rollout plan' }], workspace)).resolves.toEqual({
      references: [{ path: inside, reason: 'Rollout plan' }],
      documents: [{ path: inside, bytes: new Uint8Array(Buffer.from('ok\n')) }],
    })
  })

  it('rejects an oversize routed file', async () => {
    const { workspace } = workspaceFixture()
    writeFileSync(join(workspace, 'huge.bin'), Buffer.alloc(
      Math.min(
        REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes,
        REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * REMOTE_PROTOCOL_LIMITS.documentTransferChunks,
      ) + 1,
    ))
    await expect(validateRoutedReferences([{ path: 'huge.bin' }], workspace)).rejects.toMatchObject({
      name: 'AskUserQuestionError',
      code: 'REFERENCES_INVALID',
      message: `REFERENCES_INVALID: references[0]: path "huge.bin" exceeds the ${String(Math.min(
        REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes,
        REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * REMOTE_PROTOCOL_LIMITS.documentTransferChunks,
      ))}-byte transfer ceiling`,
    })
  })

  it('rejects a routed file that is deleted after path admission', async () => {
    const { workspace, inside } = workspaceFixture()
    unlinkSync(inside)
    await expect(validateRoutedReferences([{ path: 'inside.md' }], workspace)).rejects.toMatchObject({
      name: 'AskUserQuestionError',
      code: 'REFERENCES_INVALID',
      message: 'REFERENCES_INVALID: references[0]: path "inside.md" is unreadable or does not exist inside the session workspace',
    })
  })
})
