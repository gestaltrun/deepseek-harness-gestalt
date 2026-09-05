import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSkillInvocationMetadataViolations } from './verify-skill-invocation-metadata.ts'

const roots: string[] = []

function frontmatterOf(source: string): Record<string, unknown> {
  const frontmatter = source.split('---')[1]
  if (frontmatter === undefined) throw new Error('missing frontmatter')
  const parsed: unknown = load(frontmatter)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('frontmatter is not an object')
  }
  return parsed as Record<string, unknown>
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skill-invocation-metadata-'))
  roots.push(root)
  return root
}

function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  policy = '',
  description = 'description: Test skill\n',
): void {
  const directory = join(root, '.agents/skills', name)
  mkdirSync(join(directory, 'agents'), { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\n${description}${frontmatter}---\n\nTest.\n`)
  writeFileSync(
    join(directory, 'agents/openai.yaml'),
    `interface:\n  display_name: "Test"\n${policy}`,
  )
}

describe('cross-product skill invocation metadata gate', () => {
  it('keeps the delivery skill hash-bearing trigger in parsed metadata', () => {
    const source = readFileSync(join(import.meta.dirname, '../.agents/skills/orchestrate-dsh-delivery/SKILL.md'), 'utf8')
    const metadata = frontmatterOf(source)
    expect(metadata.description).toEqual(expect.stringContaining('implement #123'))
  })

  it('keeps work-in-progress review layers explicit', () => {
    const source = readFileSync(join(import.meta.dirname, '../.agents/skills/code-review/SKILL.md'), 'utf8')
    expect(source).toContain('git diff --cached')
    expect(source).toContain('git diff`')
    expect(source).toContain('git ls-files --others --exclude-standard')
    expect(source).toContain('does not end a work-in-progress review')
  })

  it('accepts aligned default and manual-only policies', () => {
    const root = fixtureRoot()
    writeSkill(root, 'default-skill', '')
    writeSkill(
      root,
      'manual-skill',
      'disable-model-invocation: true\nuser-invocable: true\n',
      'policy:\n  allow_implicit_invocation: false\n',
    )

    expect(collectSkillInvocationMetadataViolations(root)).toEqual([])
  })

  it('validates the parsed value of hash-bearing descriptions', () => {
    const root = fixtureRoot()
    writeSkill(
      root,
      'quoted-description',
      '',
      '',
      'description: "Review issue #123 without truncation."\n',
    )
    writeSkill(
      root,
      'block-description',
      '',
      '',
      'description: >-\n  Review issue #456 without truncation.\n',
    )
    writeSkill(
      root,
      'truncated-description',
      '',
      '',
      'description: Review issue #789 without truncation.\n',
    )

    expect(collectSkillInvocationMetadataViolations(root)).toEqual([])
    const quoted = frontmatterOf(readFileSync(join(root, '.agents/skills/quoted-description/SKILL.md'), 'utf8'))
    const block = frontmatterOf(readFileSync(join(root, '.agents/skills/block-description/SKILL.md'), 'utf8'))
    const truncated = frontmatterOf(readFileSync(join(root, '.agents/skills/truncated-description/SKILL.md'), 'utf8'))
    expect(quoted).toMatchObject({ description: 'Review issue #123 without truncation.' })
    expect(block).toMatchObject({ description: 'Review issue #456 without truncation.' })
    expect(truncated).toMatchObject({ description: 'Review issue' })
  })

  it('rejects either direction of a manual-only policy mismatch', () => {
    const root = fixtureRoot()
    writeSkill(root, 'claude-only', 'disable-model-invocation: true\n')
    writeSkill(root, 'codex-only', '', 'policy:\n  allow_implicit_invocation: false\n')

    expect(collectSkillInvocationMetadataViolations(root)).toEqual([
      '.agents/skills/claude-only: Claude Code manual-only=true but Codex manual-only=false',
      '.agents/skills/codex-only: Claude Code manual-only=false but Codex manual-only=true',
    ])
  })
})
