// @vitest-environment jsdom
/**
 * The strip pill is decorative state duplication: the count must never
 * enter the tab's accessible name (the name stays 手机·<设备名> via the
 * tab's title), so the pill renders aria-hidden. 99+ caps like the host.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { tabBadgeNode } from '../src/client/tab-badge.tsx'

afterEach(cleanup)

describe('tabBadgeNode', () => {
  it('renders the count as an aria-hidden pill node', () => {
    render(tabBadgeNode(2))
    const pill = screen.getByText('2')
    expect(pill.getAttribute('aria-hidden')).toBe('true')
  })

  it('caps three-digit counts at 99+ inside the hidden pill', () => {
    render(tabBadgeNode(142))
    expect(screen.getByText('99+').getAttribute('aria-hidden')).toBe('true')
  })

  it('renders strings as-is and hides the quiet arms', () => {
    render(tabBadgeNode('NEW'))
    expect(screen.getByText('NEW').getAttribute('aria-hidden')).toBe('true')
    expect(tabBadgeNode(null)).toBeNull()
    expect(tabBadgeNode(undefined)).toBeNull()
    expect(tabBadgeNode('')).toBeNull()
  })
})
