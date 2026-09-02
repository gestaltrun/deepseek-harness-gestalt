import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeMemberQuestionDocumentCache } from '../src/document-cache.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('writeMemberQuestionDocumentCache', () => {
  it('writes transferred bytes under a receiver-owned hidden directory and leaves a same-named Workspace file unchanged', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-question-cache-'))
    roots.push(workspace)
    await mkdir(join(workspace, 'docs'), { recursive: true })
    await writeFile(join(workspace, 'docs', 'architecture.md'), 'LOCAL WORKSPACE COPY\n')

    const cached = await writeMemberQuestionDocumentCache({
      workspacePath: workspace,
      questionId: 'question-1',
      references: [{ path: 'docs/architecture.md', reason: 'Current ownership map' }],
      documents: [{ path: 'docs/architecture.md', bytes: Buffer.from('# transferred brief\n') }],
    })

    expect(cached).toEqual([{
      path: 'docs/architecture.md',
      reason: 'Current ownership map',
      cachedPath: '.dsh/member-questions/question-1/architecture.md',
    }])
    expect(await readFile(join(workspace, 'docs', 'architecture.md'), 'utf8')).toBe('LOCAL WORKSPACE COPY\n')
    expect(await readFile(join(workspace, cached[0]!.cachedPath), 'utf8')).toBe('# transferred brief\n')
  })

  it('keeps colliding basenames unique inside the receiver-owned cache directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-question-cache-dup-'))
    roots.push(workspace)

    const cached = await writeMemberQuestionDocumentCache({
      workspacePath: workspace,
      questionId: 'question-2',
      references: [
        { path: 'notes/report.md', reason: 'Latest draft' },
        { path: 'archive/report.md', reason: 'Previous draft' },
      ],
      documents: [
        { path: 'notes/report.md', bytes: Buffer.from('latest') },
        { path: 'archive/report.md', bytes: Buffer.from('previous') },
      ],
    })

    expect(cached.map(entry => entry.cachedPath)).toEqual([
      '.dsh/member-questions/question-2/report.md',
      '.dsh/member-questions/question-2/report-2.md',
    ])
    expect(await readFile(join(workspace, cached[0]!.cachedPath), 'utf8')).toBe('latest')
    expect(await readFile(join(workspace, cached[1]!.cachedPath), 'utf8')).toBe('previous')
  })

  it('sanitizes unsafe question ids and keeps colliding extensionless names unique without writing missing bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-question-cache-safe-'))
    roots.push(workspace)

    const cached = await writeMemberQuestionDocumentCache({
      workspacePath: workspace,
      questionId: ' ../question 2 ',
      references: [
        { path: 'LICENSE', reason: 'License text' },
        { path: 'copy/LICENSE', reason: 'Duplicate name' },
        { path: 'notes/missing.bin', reason: 'Not transferred' },
      ],
      documents: [
        { path: 'LICENSE', bytes: Buffer.from('first') },
        { path: 'copy/LICENSE', bytes: Buffer.from('second') },
      ],
    })

    expect(cached.map(entry => entry.cachedPath)).toEqual([
      '.dsh/member-questions/.._question_2/LICENSE',
      '.dsh/member-questions/.._question_2/LICENSE-2',
      '.dsh/member-questions/.._question_2/missing.bin',
    ])
    expect(await readFile(join(workspace, cached[0]!.cachedPath), 'utf8')).toBe('first')
    expect(await readFile(join(workspace, cached[1]!.cachedPath), 'utf8')).toBe('second')
    await expect(readFile(join(workspace, cached[2]!.cachedPath))).rejects.toThrow()
  })

  it('uses an underscore segment for empty, dot, and parent-directory question ids', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-question-cache-empty-'))
    roots.push(workspace)

    const cached = await writeMemberQuestionDocumentCache({
      workspacePath: workspace,
      questionId: ' . ',
      references: [{ path: 'notes/readme', reason: 'Empty id' }],
      documents: [{ path: 'notes/readme', bytes: Buffer.from('ok') }],
    })
    expect(cached[0]?.cachedPath).toBe('.dsh/member-questions/_/readme')
    expect(await readFile(join(workspace, cached[0]!.cachedPath), 'utf8')).toBe('ok')
  })

  it('replaces a planted cache symlink without writing through to the Workspace twin', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-question-cache-link-'))
    roots.push(workspace)
    await mkdir(join(workspace, 'docs'), { recursive: true })
    await mkdir(join(workspace, '.dsh', 'member-questions', 'question-link'), { recursive: true, mode: 0o700 })
    const twin = join(workspace, 'docs', 'architecture.md')
    await writeFile(twin, 'LOCAL WORKSPACE COPY\n')
    const planted = join(workspace, '.dsh', 'member-questions', 'question-link', 'architecture.md')
    await symlink(twin, planted)

    const cached = await writeMemberQuestionDocumentCache({
      workspacePath: workspace,
      questionId: 'question-link',
      references: [{ path: 'docs/architecture.md', reason: 'Current ownership map' }],
      documents: [{ path: 'docs/architecture.md', bytes: Buffer.from('# transferred brief\n') }],
    })

    expect(cached[0]?.cachedPath).toBe('.dsh/member-questions/question-link/architecture.md')
    expect((await lstat(planted)).isSymbolicLink()).toBe(false)
    expect(await readFile(planted, 'utf8')).toBe('# transferred brief\n')
    expect(await readFile(twin, 'utf8')).toBe('LOCAL WORKSPACE COPY\n')
  })

  it('replaces a leftover cache file with an exclusive owner-only create', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-question-cache-exist-'))
    roots.push(workspace)
    await mkdir(join(workspace, '.dsh', 'member-questions', 'question-exist'), { recursive: true, mode: 0o700 })
    const leftover = join(workspace, '.dsh', 'member-questions', 'question-exist', 'architecture.md')
    await writeFile(leftover, 'stale')

    const cached = await writeMemberQuestionDocumentCache({
      workspacePath: workspace,
      questionId: 'question-exist',
      references: [{ path: 'docs/architecture.md', reason: 'Current ownership map' }],
      documents: [{ path: 'docs/architecture.md', bytes: Buffer.from('# transferred brief\n') }],
    })
    expect(cached[0]?.cachedPath).toBe('.dsh/member-questions/question-exist/architecture.md')
    expect(await readFile(leftover, 'utf8')).toBe('# transferred brief\n')
  })
})
