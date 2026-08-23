// @vitest-environment jsdom
// Assembled Browser snapshot: boots the real built client bundles against
// the keyless FixtureApiClient and pins the collapsed preview the fixture
// Session's last `browser/workspace` snapshot restores, then the workbench
// page chrome after open and after Refresh (navigate of the committed page).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const PREVIEW_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/browser-dock/fixture.expected.txt')
const DOCK_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/browser-dock/dock-chrome.expected.txt')

installAssembledBootEnv()

function previewShape(root: Element): string {
  const preview = root.matches('[data-browser-preview]') ? root : root.querySelector('[data-browser-preview]')
  if (preview === null) return 'preview=hidden'
  const layers = [...preview.querySelectorAll('button')].map(layer => ({
    label: layer.getAttribute('aria-label') ?? '',
    active: layer.hasAttribute('data-active'),
  }))
  return [
    'preview=shown',
    ...layers.map(layer => `layer=${layer.active ? 'current' : 'back'} ${layer.label}`),
  ].join('\n')
}

function pageShape(root: Document | Element): string {
  const page = root.querySelector('[data-browser-page]')
  if (page === null) return 'page=hidden'
  const address = page.querySelector('input')
  const img = page.querySelector('img')
  return [
    'page=shown',
    `address=${address instanceof HTMLInputElement ? address.value : ''}`,
    `screenshot=${img?.getAttribute('alt') ?? 'none'}`,
  ].join('\n')
}

async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
}

describe('assembled Browser Dock preview', () => {
  it('restores the collapsed layered preview from the fixture Session Workspace', async () => {
    mountAssembledApp()
    await openFixtureSession()
    const preview = await waitFor(() => {
      const found = document.querySelector('[data-browser-preview]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })
    const shape = previewShape(preview)
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(PREVIEW_EXPECTED), { recursive: true })
      writeFileSync(PREVIEW_EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(PREVIEW_EXPECTED)
  })

  it('keeps workbench page chrome on the committed page after open and Refresh, not about:blank', async () => {
    mountAssembledApp()
    await openFixtureSession()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Example Domain' }, { timeout: 10_000 }))
    const opened = await waitFor(() => {
      const shape = pageShape(document)
      expect(shape).not.toBe('page=hidden')
      expect(shape).not.toContain('about:blank')
      return shape
    }, { timeout: 10_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    const refreshed = await waitFor(() => {
      const shape = pageShape(document)
      expect(shape).toContain('address=https://example.test/')
      expect(shape).not.toContain('about:blank')
      return shape
    }, { timeout: 10_000 })
    const shape = `${['after-open', opened, 'after-refresh', refreshed].join('\n')}\n`
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(DOCK_EXPECTED), { recursive: true })
      writeFileSync(DOCK_EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(DOCK_EXPECTED)
  })
})
