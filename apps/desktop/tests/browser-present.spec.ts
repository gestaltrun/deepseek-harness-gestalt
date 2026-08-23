import { describe, expect, it } from 'vitest'
import {
  parseBrowserPresentRequest,
  parseBrowserPresentTarget,
  screenBoundsOf,
} from '../src/browser-present.ts'

const TARGET = {
  profileId: 'p',
  workspaceId: 'w',
  browserId: 'b',
  tabId: 't',
}

const BOUNDS = { x: 10.4, y: 20.6, width: 640, height: 480 }

describe('browser present IPC', () => {
  it('accepts a complete request and maps content-relative bounds onto the screen', () => {
    expect(parseBrowserPresentRequest({ target: TARGET, bounds: BOUNDS })).toEqual({
      target: TARGET,
      bounds: BOUNDS,
    })
    expect(screenBoundsOf({ x: 116, y: 33, width: 1280, height: 800 }, BOUNDS)).toEqual({
      x: 126,
      y: 54,
      width: 640,
      height: 480,
    })
  })

  it('rejects unusable identities and rectangles', () => {
    expect(parseBrowserPresentRequest(undefined)).toBeUndefined()
    expect(parseBrowserPresentRequest({ target: TARGET })).toBeUndefined()
    expect(parseBrowserPresentRequest({
      target: { ...TARGET, tabId: '' },
      bounds: BOUNDS,
    })).toBeUndefined()
    expect(parseBrowserPresentRequest({
      target: TARGET,
      bounds: { ...BOUNDS, width: 7 },
    })).toBeUndefined()
    expect(parseBrowserPresentRequest({
      target: TARGET,
      bounds: { ...BOUNDS, height: 20_000 },
    })).toBeUndefined()
    expect(parseBrowserPresentRequest({
      target: TARGET,
      bounds: { ...BOUNDS, x: Number.NaN },
    })).toBeUndefined()
    expect(parseBrowserPresentTarget('nope')).toBeUndefined()
    expect(parseBrowserPresentTarget({ ...TARGET, profileId: 1 })).toBeUndefined()
  })
})
