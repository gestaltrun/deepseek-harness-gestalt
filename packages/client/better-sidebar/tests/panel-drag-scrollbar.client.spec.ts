import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('panel resize scrollbar presentation', () => {
  it('keeps the conversation scrollbar thumb quiet while panel geometry changes', () => {
    const source = readFileSync(
      join(process.cwd(), 'packages/client/better-sidebar/src/client/sidebar.module.css'),
      'utf8',
    )
    const rule = /:global\(body\[data-dsh-sidebar-dragging\] \[data-conversation-scroll\]\)\s*\{(?<body>[^}]+)\}/
      .exec(source)?.groups?.body ?? ''
    expect(rule).toContain('--dsh-scrollbar-thumb: transparent')
    expect(rule).toContain('--dsh-scrollbar-thumb-hover: transparent')
  })
})
