import { describe, expect, it } from 'vitest'
import {
  BROWSER_PREVIEW_RAIL_MIN_PX,
  previewRailTight,
  rightGutterPx,
} from '../src/client/chat/preview-rail.ts'

describe('preview rail gutter', () => {
  it('treats an unmeasured scrollport as roomy', () => {
    expect(rightGutterPx(0, 640)).toBe(Number.POSITIVE_INFINITY)
    expect(rightGutterPx(1200, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(previewRailTight(0, 640)).toBe(false)
  })

  it('hides when the right gutter is narrower than the rail', () => {
    expect(rightGutterPx(1120, 640)).toBe(240)
    expect(previewRailTight(1120, 640)).toBe(false)
    expect(previewRailTight(1118, 640)).toBe(true)
    expect(rightGutterPx(800, 640)).toBe(80)
    expect(previewRailTight(800, 640)).toBe(true)
    expect(BROWSER_PREVIEW_RAIL_MIN_PX).toBe(240)
  })
})
