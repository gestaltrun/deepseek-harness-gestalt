/** Phone settings card stylesheet contract. */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/PhoneSettingsCard.module.css', import.meta.url)),
  'utf8',
)
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`PhoneSettingsCard.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('PhoneSettingsCard theme styles', () => {
  it('names only declared theme variables', () => {
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
  })

  it('keeps enabled 打开面板 label contrast on the primary fill', () => {
    const enabled = block('.openDevice:not(:disabled)')
    expect(enabled).toContain('background: var(--dsw-alias-button-primary-fill)')
    expect(enabled).toContain('color: var(--dsw-alias-label-primary-foreground)')
    expect(enabled).not.toContain('--dsw-static-neutral-bluish-00')
    const hover = block('.openDevice:not(:disabled):hover')
    expect(hover).toContain('color: var(--dsw-alias-label-primary-foreground)')
    expect(hover).not.toContain('--dsw-static-neutral-bluish-00')
  })
})
