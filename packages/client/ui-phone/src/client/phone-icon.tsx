/**
 * Monochrome inline phone glyph for the tab strip and the + menu row.
 * Stroke follows the built-in 16-grid icons (1.3px stroke, currentColor),
 * matching the locked mockup's handset drawing.
 */
export function PhoneTabIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.6" y="1.6" width="6.8" height="12.8" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="12" r=".95" fill="currentColor" />
    </svg>
  )
}
