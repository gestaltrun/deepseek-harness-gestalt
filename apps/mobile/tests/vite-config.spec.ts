import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Mobile Vite config', () => {
  it('resolves workspace packages and targets the supported WebView floor', () => {
    const production = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    const snapshot = readFileSync(new URL('./product-entry.vite.config.ts', import.meta.url), 'utf8')
    expect(production).toContain('tsconfigPaths')
    expect(production).toContain('tsconfig.base.json')
    expect(production).toContain("target: 'chrome83'")
    expect(snapshot).toContain("target: 'chrome83'")
  })
})
