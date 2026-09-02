import { describe, expect, it } from 'vitest'
import { isExpectedSessionSurface } from './e2e-sub2api/session-surface.ts'

describe('Sub2API Electron session surface selection', () => {
  it('rejects the same-origin console route after returning to the Session Surface', () => {
    const sessionUrl = 'http://127.0.0.1:51244/'

    expect(isExpectedSessionSurface({
      overlay: false,
      url: 'http://127.0.0.1:51244/home',
    }, sessionUrl)).toBe(false)
    expect(isExpectedSessionSurface({
      overlay: false,
      url: sessionUrl,
    }, sessionUrl)).toBe(true)
  })

  it('always rejects the Desktop overlay document', () => {
    expect(isExpectedSessionSurface({
      overlay: true,
      url: 'http://127.0.0.1:51244/',
    }, 'http://127.0.0.1:51244/')).toBe(false)
  })
})
