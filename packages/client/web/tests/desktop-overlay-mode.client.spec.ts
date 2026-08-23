// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_OVERLAY_ATTR, isDesktopOverlayDocument, isDesktopOverlaySearch, markDesktopOverlayDocument,
} from '../src/desktop-overlay-mode.ts'

afterEach(() => {
  document.documentElement.removeAttribute(DESKTOP_OVERLAY_ATTR)
})

describe('desktop overlay mode', () => {
  it('reads the overlay query', () => {
    expect(isDesktopOverlaySearch('')).toBe(false)
    expect(isDesktopOverlaySearch('?foo=1')).toBe(false)
    expect(isDesktopOverlaySearch('?dsh-desktop-overlay=0')).toBe(false)
    expect(isDesktopOverlaySearch('?dsh-desktop-overlay=1')).toBe(true)
    expect(isDesktopOverlaySearch('dsh-desktop-overlay=1')).toBe(true)
  })

  it('treats the stamped attribute as the overlay document', () => {
    expect(isDesktopOverlayDocument()).toBe(isDesktopOverlaySearch(location.search))
    document.documentElement.setAttribute(DESKTOP_OVERLAY_ATTR, '')
    expect(isDesktopOverlayDocument()).toBe(true)
  })

  it('stamps the attribute only for an overlay query', () => {
    markDesktopOverlayDocument()
    expect(document.documentElement.hasAttribute(DESKTOP_OVERLAY_ATTR)).toBe(
      isDesktopOverlaySearch(location.search),
    )
    const url = new URL(location.href)
    url.searchParams.set('dsh-desktop-overlay', '1')
    history.replaceState({}, '', url)
    markDesktopOverlayDocument()
    expect(document.documentElement.hasAttribute(DESKTOP_OVERLAY_ATTR)).toBe(true)
    url.searchParams.delete('dsh-desktop-overlay')
    history.replaceState({}, '', url)
  })
})
