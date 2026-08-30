/** Tests for documentation build-output lifecycle ownership. */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetDocumentationBuildOutput } from '../website/build.ts'
import { emitRawMarkdownPages, type ProjectionContext } from './project-doc-site.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { outDir: string; context: ProjectionContext } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dsh-doc-build-'))
  roots.push(repoRoot)
  mkdirSync(join(repoRoot, 'docs'))
  writeFileSync(join(repoRoot, 'docs/a.md'), '# A\n')
  return {
    outDir: join(repoRoot, 'website/.dist'),
    context: {
      pages: [{
        locale: 'root',
        contentLocale: 'en-US',
        source: 'docs/a.md',
        route: 'a.md',
        label: 'A',
        sidebar: 'zh-reference',
        section: 'Test',
        order: 1,
      }],
      repoRoot: realpathSync(repoRoot),
      repositoryRef: 'abc123',
    },
  }
}

describe('resetDocumentationBuildOutput', () => {
  it('lets two consecutive builds replace the preceding build output', () => {
    const { outDir, context } = fixture()

    for (let build = 0; build < 2; build += 1) {
      resetDocumentationBuildOutput(outDir)
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'index.html'), `<p>build ${build}</p>\n`)
      emitRawMarkdownPages(outDir, context)

      expect(readFileSync(join(outDir, 'a.md'), 'utf8')).toBe('# A\n')
      expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toBe(`<p>build ${build}</p>\n`)
    }
  })

  it.each([
    {
      name: 'page',
      publicPath: 'a.md',
      prepareSource: (context: ProjectionContext) => context,
    },
    {
      name: 'image',
      publicPath: 'logo.svg',
      prepareSource: (context: ProjectionContext) => {
        mkdirSync(join(context.repoRoot, 'packages'))
        writeFileSync(join(context.repoRoot, 'packages/logo.svg'), '<svg/>\n')
        writeFileSync(join(context.repoRoot, 'docs/a.md'), '![logo](../packages/logo.svg)\n')
        return context
      },
    },
  ])('leaves a current-build public $name collision in place', ({ publicPath, prepareSource }) => {
    const { outDir, context } = fixture()
    const publicDir = join(context.repoRoot, 'website/public')
    mkdirSync(publicDir, { recursive: true })
    writeFileSync(join(publicDir, publicPath), 'public copy\n')

    // VitePress resolves and clears its owned output before it recopies the
    // current `website/public` tree. Raw projection runs only after that copy.
    resetDocumentationBuildOutput(outDir)
    cpSync(publicDir, outDir, { recursive: true })

    expect(() => {
      emitRawMarkdownPages(outDir, prepareSource(context))
    }).toThrow(
      `would overwrite existing build file ${publicPath}`,
    )
    expect(readFileSync(join(outDir, publicPath), 'utf8')).toBe('public copy\n')
  })

  it('does not follow a link-shaped output directory', () => {
    const { outDir } = fixture()
    const target = mkdtempSync(join(tmpdir(), 'dsh-doc-build-target-'))
    roots.push(target)
    writeFileSync(join(target, 'keep.txt'), 'keep\n')
    mkdirSync(join(outDir, '..'), { recursive: true })
    // `junction` gives Windows the directory-link form that recursive removal
    // must not traverse; POSIX creates an ordinary directory symlink.
    symlinkSync(target, outDir, 'junction')

    resetDocumentationBuildOutput(outDir)

    expect(existsSync(outDir)).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep\n')
  })
})
