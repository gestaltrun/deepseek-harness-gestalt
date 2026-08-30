/** Tests for documentation build-output lifecycle ownership. */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDocumentationSite } from '../website/build.ts'
import { emitRawMarkdownPages, type ProjectionContext } from './project-doc-site.ts'

interface SiteBuildOptions {
  mpa?: string
  onAfterConfigResolve: (siteConfig: { outDir: string }) => void
}

type SiteBuild = (siteRoot?: string, options?: SiteBuildOptions) => Promise<void>

const mocks = vi.hoisted(() => ({ vitepressBuild: vi.fn<SiteBuild>() }))
vi.mock('../website/vitepress.ts', () => ({ build: mocks.vitepressBuild }))

const roots: string[] = []
const repositoryRoot = resolve(import.meta.dirname, '..')
const buildMock = mocks.vitepressBuild

afterEach(() => {
  vi.clearAllMocks()
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

function mockCurrentBuild(outDir: string, mpa: boolean, writeCurrentOutput: () => void): void {
  buildMock.mockImplementation(async (siteRoot, options) => {
    expect(siteRoot).toBe(join(repositoryRoot, 'website'))
    if (options === undefined) throw new Error('VitePress build received no options.')
    expect(options.mpa).toBe(mpa ? 'true' : undefined)
    options.onAfterConfigResolve({ outDir })
    writeCurrentOutput()
  })
}

describe('buildDocumentationSite', () => {
  it('lets two consecutive shipped builds replace the preceding build output', async () => {
    const { outDir, context } = fixture()
    let buildNumber = 0
    mockCurrentBuild(outDir, true, () => {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'index.html'), `<p>build ${buildNumber}</p>\n`)
      emitRawMarkdownPages(outDir, context)
      buildNumber += 1
    })

    await buildDocumentationSite(true)
    await buildDocumentationSite(true)

    expect(buildMock).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(outDir, 'a.md'), 'utf8')).toBe('# A\n')
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toBe('<p>build 1</p>\n')
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
  ])('leaves a current-build public $name collision in place', async ({ publicPath, prepareSource }) => {
    const { outDir, context } = fixture()
    const publicDir = join(context.repoRoot, 'website/public')
    mkdirSync(publicDir, { recursive: true })
    writeFileSync(join(publicDir, publicPath), 'public copy\n')

    mockCurrentBuild(outDir, true, () => {
      // The mock follows VitePress's order: its lifecycle callback runs before
      // current `website/public` files and raw twins are emitted.
      cpSync(publicDir, outDir, { recursive: true })
      emitRawMarkdownPages(outDir, prepareSource(context))
    })

    await expect(buildDocumentationSite(true)).rejects.toThrow(
      `would overwrite existing build file ${publicPath}`,
    )
    expect(readFileSync(join(outDir, publicPath), 'utf8')).toBe('public copy\n')
  })

  it('does not follow a link-shaped resolved output directory', async () => {
    const { outDir } = fixture()
    const target = mkdtempSync(join(tmpdir(), 'dsh-doc-build-target-'))
    roots.push(target)
    writeFileSync(join(target, 'keep.txt'), 'keep\n')
    mkdirSync(join(outDir, '..'), { recursive: true })
    // `junction` gives Windows the directory-link form that recursive removal
    // must not traverse; POSIX creates an ordinary directory symlink.
    symlinkSync(target, outDir, 'junction')
    mockCurrentBuild(outDir, false, () => {})

    await buildDocumentationSite(false)

    expect(existsSync(outDir)).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep\n')
  })
})
