import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Mobile safe-area layout', () => {
  it('contains Session header padding inside its safe-area-aware height', () => {
    const styles = readFileSync(new URL('../src/MobileBrowse.module.css', import.meta.url), 'utf8')
    const headers = styles.match(/\.remoteHeader,\s*\.header,\s*\.routeHeader\s*\{([\s\S]*?)\}/u)?.[1]

    expect(headers).toBeDefined()
    expect(headers).toContain('box-sizing: border-box')
    expect(headers).toContain('min-height: calc(64px + env(safe-area-inset-top))')
    expect(headers).toContain('padding: calc(12px + env(safe-area-inset-top)) 16px 12px')
  })
})
