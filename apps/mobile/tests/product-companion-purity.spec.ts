import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const productSources = [
  new URL('../src/main.tsx', import.meta.url),
  new URL('../../desktop/src/main.ts', import.meta.url),
  new URL('../../desktop/src/remote-relay.ts', import.meta.url),
]

describe('Companion product composition purity', () => {
  it('imports no keyless pairing or application cipher provider', () => {
    const source = productSources.map(url => readFileSync(url, 'utf8')).join('\n')
    expect(source).not.toMatch(/DevelopmentKeyless|PERSONAL_PAIRING_KEYLESS|development-keyless/u)
    expect(readFileSync(productSources[0] as URL, 'utf8')).toContain('@deepseek-ai/dsh-noise-channel')
  })

  it('routes Mobile runtime UUID generation through the owned helper', () => {
    const source = sourceFiles(new URL('../src/', import.meta.url))
      .filter(url => !url.pathname.endsWith('/webview-compat.ts'))
      .map(url => readFileSync(url, 'utf8'))
      .join('\n')
    expect(source).not.toContain('crypto.randomUUID(')
  })
})

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) return sourceFiles(url)
    return /\.tsx?$/u.test(entry.name) ? [url] : []
  })
}
