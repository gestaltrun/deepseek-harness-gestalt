import { describe, expect, it } from 'vitest'
import { layoutPushSize } from '../src/client/layout-push.ts'

describe('panel layout push', () => {
  it('keeps a closed right panel out of the layout while resizing the bottom panel', () => {
    expect(layoutPushSize({
      panelOpen: false,
      bottomOpen: true,
      narrow: false,
      width: 448,
      bottomHeight: 351,
      viewportWidth: 1440,
      viewportHeight: 900,
    })).toEqual({ width: 0, height: 351 })
  })
})
