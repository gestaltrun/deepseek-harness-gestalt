import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOOT_BACKGROUND_DARK,
  BOOT_BACKGROUND_LIGHT,
  SHELL_READY_EXPRESSION,
  bootBackgroundColor,
  joinHostAfter,
  pollUntilTrue,
  probeShellReady,
} from '../src/boot-session.ts'

const desktopRoot = join(process.cwd(), 'apps/desktop')
const bootHtml = readFileSync(join(desktopRoot, 'src/boot.html'), 'utf8')

describe('joinHostAfter', () => {
  it('starts the Host before Account work settles', async () => {
    const order: string[] = []
    let releaseHost!: () => void
    const hostHold = new Promise<void>((resolve) => { releaseHost = resolve })
    const host = joinHostAfter(
      async () => {
        order.push('host-start')
        await hostHold
        order.push('host-ready')
        return 'running'
      },
      async () => {
        order.push('account-start')
        expect(order).toEqual(['host-start', 'account-start'])
        order.push('account-ready')
        releaseHost()
      },
    )
    expect(await host).toBe('running')
    expect(order).toEqual(['host-start', 'account-start', 'account-ready', 'host-ready'])
  })
})

describe('pollUntilTrue', () => {
  it('returns true once the probe succeeds and false at the deadline', async () => {
    let now = 0
    let hits = 0
    const ok = await pollUntilTrue(async () => {
      hits += 1
      return hits >= 3
    }, 1_000, {
      now: () => now,
      sleep: async (ms) => { now += ms },
    })
    expect(ok).toBe(true)
    expect(hits).toBe(3)

    now = 0
    const missed = await pollUntilTrue(async () => false, 120, {
      now: () => now,
      sleep: async (ms) => { now += ms },
    })
    expect(missed).toBe(false)
  })

  it('keeps polling when a probe throws', async () => {
    let now = 0
    let hits = 0
    const ok = await pollUntilTrue(async () => {
      hits += 1
      if (hits === 1) throw new Error('navigating')
      return true
    }, 1_000, {
      now: () => now,
      sleep: async (ms) => { now += ms },
    })
    expect(ok).toBe(true)
  })
})

describe('probeShellReady', () => {
  it('accepts only the published ready flag', async () => {
    expect(await probeShellReady(async () => true)).toBe(true)
    expect(await probeShellReady(async () => false)).toBe(false)
    expect(await probeShellReady(async () => {
      throw new Error('destroyed')
    })).toBe(false)
    expect(SHELL_READY_EXPRESSION).toContain('__DSH_SHELL_READY__')
    expect(SHELL_READY_EXPRESSION).toContain('data-desktop-chrome')
    expect(SHELL_READY_EXPRESSION).toContain('Failed to load plugins')
  })
})

describe('boot mark', () => {
  it('is a self-contained GESTALT page that follows the OS scheme', () => {
    expect(bootBackgroundColor(false)).toBe(BOOT_BACKGROUND_LIGHT)
    expect(bootBackgroundColor(true)).toBe(BOOT_BACKGROUND_DARK)
    expect(bootHtml).toContain('DeepSeek Gestalt')
    expect(bootHtml).toContain('<span>G</span><span>E</span><span>S</span><span>T</span><span>A</span><span>L</span><span>T</span>')
    expect(bootHtml).toContain(BOOT_BACKGROUND_LIGHT)
    expect(bootHtml).toContain(BOOT_BACKGROUND_DARK)
    expect(bootHtml).toContain('prefers-color-scheme: dark')
    expect(bootHtml).toContain('prefers-reduced-motion: reduce')
    expect(bootHtml).toContain('-webkit-app-region: drag')
    expect(bootHtml).not.toMatch(/https?:\/\//)
    expect(bootHtml).not.toContain('<script')
  })

  it('ships next to the bundled main process', () => {
    const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
      build: { files: string[] }
    }
    expect(manifest.build.files).toContain('out/boot.html')
    const buildMain = readFileSync(join(desktopRoot, 'scripts/build-main.mjs'), 'utf8')
    expect(buildMain).toContain("join(root, 'src', 'boot.html')")
    const main = readFileSync(join(desktopRoot, 'src/main.ts'), 'utf8')
    expect(main).toContain('attachBootScreen(')
    expect(main).toContain('waitForShellReady(')
    expect(main).toContain('revealHost(')
  })
})
