// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchMobileProduct } from '../src/mobile-product-launch.ts'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('launchMobileProduct', () => {
  it('projects a startup failure instead of leaving the packaged root blank', async () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    const failure = new Error('Protected Mobile value cannot be opened')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(launchMobileProduct(async () => { throw failure })).rejects.toBe(failure)

    const alert = root.querySelector('[data-mobile-startup="failed"]')
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain('Mobile 启动失败 / Startup failed')
    expect(alert?.textContent).toContain(failure.message)
    expect(console.error).toHaveBeenCalledWith('[mobile-product] startup failed:', failure)
  })
})
