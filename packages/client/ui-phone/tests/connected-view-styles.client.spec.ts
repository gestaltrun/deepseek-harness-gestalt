/** Connected phone view stylesheet contract: the frame box follows the measured surface aspect. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/PhoneConnectedView.module.css', import.meta.url)),
  'utf8',
)

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`PhoneConnectedView.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('PhoneConnectedView screen-frame styles', () => {
  it('sizes the frame from the measured surface ratio with the locked 1:2 placeholder fallback', () => {
    const frame = block('.screenFrame')
    expect(frame).toContain('width: min(100cqw, 100cqh * var(--phone-surface-ratio, 0.5))')
    expect(frame).toContain('height: min(100cqh, 100cqw / var(--phone-surface-ratio, 0.5))')
  })

  it('maps frames into the box without distorting pixels', () => {
    expect(block('.stream')).toContain('object-fit: contain')
    expect(css).not.toContain('object-fit: fill')
  })
})
