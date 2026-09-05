import { IconPhoneOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Monochrome inline phone glyph for the tab strip and the + menu row.
 * Stroke follows the built-in 16-grid icons (1.3px stroke, currentColor),
 * matching the locked mockup's handset drawing.
 */
export function PhoneTabIcon({ size }: { size: number }): React.JSX.Element {
  return <IconPhoneOutline16 size={size} />
}
