/** Mobile Access switch stylesheet contract. */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AccountControl.module.css', import.meta.url)),
  'utf8',
)
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`AccountControl.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('AccountControl theme styles', () => {
  it('names only declared theme variables', () => {
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
  })

  it('keeps the disabled Mobile Access track and thumb visible in both themes', () => {
    const track = block('.toggle')
    expect(track).toContain('background: var(--dsw-alias-button-primary-dimmed, rgba(127, 130, 135, 0.42))')
    expect(track).toContain('border: 1px solid var(--dsw-alias-border-l3, rgba(127, 130, 135, 0.72))')
    expect(track).not.toContain('--dsw-alias-fill-tertiary')
    expect(block('.toggle span')).toContain('background: var(--dsw-static-neutral-bluish-00, rgb(255, 255, 255))')
  })

  it('keeps a visible keyboard focus indicator', () => {
    expect(block('.toggle:focus-visible')).toContain('outline: 2px solid var(--dsw-alias-button-info-fill, rgb(65, 118, 230))')
  })

  it('keeps the enabled track visible without the shared palette', () => {
    const enabled = block(".toggle\\[aria-checked='true'\\]")
    expect(enabled).toContain('border-color: var(--dsw-alias-button-info-fill, rgb(65, 118, 230))')
    expect(enabled).toContain('background: var(--dsw-alias-button-info-fill, rgb(65, 118, 230))')
  })
})
