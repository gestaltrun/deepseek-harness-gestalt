/**
 * The tab-strip badge pill: one decorative node rendering the descriptor's
 * badge value. The pill is aria-hidden by contract — a count or state mark
 * duplicates what the tab title already names, and letting it into the
 * accessible stream pollutes the tab's name (accessibility finding P3).
 * @module @deepseek-ai/dsh-client-ui-better-sidebar/client/tab-badge
 */
import type { ReactNode } from 'react'
import css from './sidebar.module.css'

/**
 * Render one badge pill node for the tab strip.
 * @param value - the descriptor badge value; null/undefined/'' hide the pill.
 * @returns the aria-hidden pill node, or null when the badge is quiet.
 */
export function tabBadgeNode(value: string | number | null | undefined): ReactNode {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'number' ? (value > 99 ? '99+' : String(value)) : String(value)
  return <span className={css.tabBadge} aria-hidden="true">{text}</span>
}
