import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfigFileTextToJson } from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectGestaltCompilerFaceViolations,
  collectProjectReferenceFaceViolations,
} from './project-reference-faces.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readConfig(path: string): { readonly include?: readonly string[]; readonly exclude?: readonly string[] } {
  const result = parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (result.error) throw new Error(`Cannot parse ${path}`)
  return result.config as { readonly include?: readonly string[]; readonly exclude?: readonly string[] }
}

function workspaceFixture(options: {
  readonly host: readonly string[]
  readonly client: readonly string[]
}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-reference-faces-'))
  roots.push(root)
  const shared = join(root, 'packages/core/shared')
  const split = join(root, 'packages/api/split')
  mkdirSync(shared, { recursive: true })
  mkdirSync(split, { recursive: true })
  writeJson(join(root, 'tsconfig.base.json'), {})
  writeJson(join(root, 'tsconfig.base.client.json'), { extends: './tsconfig.base.json' })
  writeJson(join(shared, 'package.json'), { name: '@deepseek-ai/dsh-shared' })
  writeJson(join(shared, 'tsconfig.json'), {
    extends: '../../../tsconfig.base.json',
    references: [],
  })
  writeJson(join(split, 'package.json'), { name: '@deepseek-ai/dsh-split' })
  writeJson(join(split, 'tsconfig.json'), {
    files: [],
    references: [{ path: './tsconfig.host.json' }, { path: './tsconfig.client.json' }],
  })
  writeJson(join(split, 'tsconfig.host.json'), { references: [{ path: '../../core/shared' }] })
  writeJson(join(split, 'tsconfig.client.json'), { references: [{ path: '../../core/shared' }] })
  writeJson(join(root, 'tsconfig.host.json'), {
    references: options.host.map(path => ({ path })),
  })
  writeJson(join(root, 'tsconfig.client.json'), {
    references: options.client.map(path => ({ path })),
  })
  return root
}

describe('Project Reference compiler faces', () => {
  it('assigns Web Host tests to the Host aggregate only', () => {
    const repositoryRoot = join(import.meta.dirname, '..')
    const web = readConfig(join(repositoryRoot, 'apps/web/tsconfig.json'))
    const host = readConfig(join(repositoryRoot, 'tsconfig.host.json'))

    expect(web.exclude).toEqual(expect.arrayContaining([
      'tests/annotation-persistence.e2e.ts',
      'tests/annotation-images.e2e.ts',
      'tests/web-acceptance.acceptance.ts',
    ]))
    expect(host.include).toEqual(expect.arrayContaining([
      'apps/web/tests/annotation-persistence.e2e.ts',
      'apps/web/tests/annotation-images.e2e.ts',
      'apps/web/tests/web-acceptance.acceptance.ts',
    ]))
  })

  it('allows neutral projects in either graph and matching split leaves', () => {
    const root = workspaceFixture({
      host: ['./packages/core/shared', './packages/api/split/tsconfig.host.json'],
      client: ['./packages/core/shared', './packages/api/split/tsconfig.client.json'],
    })

    expect(collectProjectReferenceFaceViolations(root)).toEqual([])
  })

  it('rejects a retained Gestalt project omitted from its compiler face', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-reference-faces-'))
    roots.push(root)
    mkdirSync(join(root, 'apps/desktop'), { recursive: true })
    writeJson(join(root, 'apps/desktop/tsconfig.json'), { extends: '../../tsconfig.base.json' })
    writeJson(join(root, 'tsconfig.base.json'), {})
    writeJson(join(root, 'tsconfig.base.client.json'), {})
    writeJson(join(root, 'tsconfig.host.json'), { references: [] })
    writeJson(join(root, 'tsconfig.client.json'), { references: [] })

    expect(collectGestaltCompilerFaceViolations(root, {
      host: ['apps/desktop'],
      client: [],
    })).toEqual([
      'apps/desktop/tsconfig.json: retained Gestalt project is omitted from the root Host aggregate',
    ])
  })

  it('rejects apps/platform when both the aggregate and inventory omit it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-reference-faces-'))
    roots.push(root)
    mkdirSync(join(root, 'apps/platform'), { recursive: true })
    writeJson(join(root, 'apps/platform/tsconfig.json'), { extends: '../../tsconfig.base.json' })
    writeJson(join(root, 'tsconfig.base.json'), {})
    writeJson(join(root, 'tsconfig.base.client.json'), {})
    writeJson(join(root, 'tsconfig.host.json'), { references: [] })
    writeJson(join(root, 'tsconfig.client.json'), { references: [] })

    expect(collectGestaltCompilerFaceViolations(root, { host: [], client: [] })).toEqual([
      'apps/platform/tsconfig.json: retained Gestalt Host project is omitted from GESTALT_COMPILER_FACES',
    ])
  })

  it('rejects the opposite leaf and the solution root of a split project', () => {
    const root = workspaceFixture({
      host: [
        './packages/api/split/tsconfig.host.json',
        './packages/api/split/tsconfig.client.json',
      ],
      client: ['./packages/api/split'],
    })

    expect(collectProjectReferenceFaceViolations(root)).toEqual([
      'tsconfig.client.json: Project Reference "./packages/api/split" enters split project packages/api/split from a Client config; reference "packages/api/split/tsconfig.client.json" instead',
      'tsconfig.host.json: Project Reference "./packages/api/split/tsconfig.client.json" enters split project packages/api/split from a Host config; reference "packages/api/split/tsconfig.host.json" instead',
    ])
  })

  it('uses the referencing project face throughout the reachable graph', () => {
    const root = workspaceFixture({
      host: ['./packages/core/host-consumer'],
      client: ['./packages/core/client-consumer'],
    })
    const hostConsumer = join(root, 'packages/core/host-consumer')
    mkdirSync(hostConsumer, { recursive: true })
    writeJson(join(hostConsumer, 'package.json'), { name: '@deepseek-ai/dsh-host-consumer' })
    writeJson(join(hostConsumer, 'tsconfig.json'), {
      extends: '../../../tsconfig.base.json',
      references: [{ path: '../../api/split/tsconfig.client.json' }],
    })
    const clientConsumer = join(root, 'packages/core/client-consumer')
    mkdirSync(clientConsumer, { recursive: true })
    writeJson(join(clientConsumer, 'package.json'), { name: '@deepseek-ai/dsh-client-consumer' })
    writeJson(join(clientConsumer, 'tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      references: [{ path: '../../api/split/tsconfig.host.json' }],
    })

    expect(collectProjectReferenceFaceViolations(root)).toEqual([
      'packages/core/client-consumer/tsconfig.json: Project Reference "../../api/split/tsconfig.host.json" enters split project packages/api/split from a Client config; reference "packages/api/split/tsconfig.client.json" instead',
      'packages/core/host-consumer/tsconfig.json: Project Reference "../../api/split/tsconfig.client.json" enters split project packages/api/split from a Host config; reference "packages/api/split/tsconfig.host.json" instead',
    ])
  })
})
