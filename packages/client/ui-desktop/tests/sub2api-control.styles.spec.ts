import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/Sub2ApiControl.module.css')
const componentSource = readFileSync(componentPath, 'utf8')

describe('Sub2API native workspace frame', () => {
  it('does not paint a second container border around the native account workspace', () => {
    const block = componentSource.match(/\.consoleFrame\s*\{([^}]*)\}/)?.[1]
    expect(block).toBeDefined()
    expect(block).toMatch(/border:\s*(?:0|none)\s*;/)
  })
})
