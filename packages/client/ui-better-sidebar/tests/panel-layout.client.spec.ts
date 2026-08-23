import { describe, expect, it } from 'vitest'
import { resolvePanelPush } from '../src/client/state.ts'

describe('panel layout push', () => {
  it('keeps a closed right panel out of the layout while resizing the bottom panel', () => {
    expect(resolvePanelPush(
      { panelOpen: false, bottomOpen: true },
      false,
      { width: 448, height: 351 },
    )).toEqual({ width: 0, height: 351 })
  })
})
