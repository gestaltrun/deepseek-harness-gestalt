/** Tests for the documentation build CLI wiring. */

import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ buildDocumentationSite: vi.fn(async () => {}) }))
vi.mock('../website/build.ts', () => mocks)

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.clearAllMocks()
})

it('routes --mpa through the fixed-site build capability', async () => {
  process.argv = [process.execPath, resolve(import.meta.dirname, '../website/build-cli.ts'), '--mpa']

  await import('../website/build-cli.ts')

  expect(mocks.buildDocumentationSite).toHaveBeenCalledExactlyOnceWith(true)
})
