// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import {
  notifyOverlayLock, subscribeOverlayLock, useOverlayLock,
} from '../src/overlay-lock.ts'

afterEach(() => {
  cleanup()
})

describe('overlay lock', () => {
  it('notifies subscribers while any holder is open', () => {
    const held: boolean[] = []
    const unlock = subscribeOverlayLock((next) => { held.push(next) })
    notifyOverlayLock(true)
    notifyOverlayLock(true)
    notifyOverlayLock(false)
    notifyOverlayLock(false)
    window.dispatchEvent(new Event('dsh-overlay-lock'))
    notifyOverlayLock(false)
    unlock()
    notifyOverlayLock(true)
    expect(held).toEqual([true, true, true, false, false, false])
  })

  it('holds the lock for the lifetime of a hook', () => {
    const held: boolean[] = []
    const unlock = subscribeOverlayLock((next) => { held.push(next) })
    const hook = renderHook(({ open }) => { useOverlayLock(open) }, { initialProps: { open: false } })
    hook.rerender({ open: true })
    hook.rerender({ open: false })
    hook.unmount()
    unlock()
    expect(held).toEqual([true, false])
  })
})
