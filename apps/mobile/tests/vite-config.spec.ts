import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Mobile Vite config', () => {
  it('resolves workspace packages through the repository tsconfig paths', () => {
    const source = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(source).toContain('tsconfigPaths')
    expect(source).toContain('tsconfig.base.json')
  })
})
