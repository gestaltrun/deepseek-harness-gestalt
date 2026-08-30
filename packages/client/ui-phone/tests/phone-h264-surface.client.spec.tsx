// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const playPhoneH264Stream = vi.hoisted(() => vi.fn())

vi.mock('../src/client/phone-h264-playback.ts', () => ({ playPhoneH264Stream }))

import { PhoneH264Surface } from '../src/client/PhoneH264Surface.tsx'

afterEach(() => { vi.restoreAllMocks() })

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve: () => { resolve?.() } }
}

describe('PhoneH264Surface playback ownership', () => {
  it('waits for prior playback quiescence before starting a replacement URL', async () => {
    const firstSettlement = deferred()
    const secondSettlement = deferred()
    const firstClose = vi.fn(() => firstSettlement.promise)
    const secondClose = vi.fn(() => secondSettlement.promise)
    playPhoneH264Stream
      .mockReturnValueOnce({ close: firstClose })
      .mockReturnValueOnce({ close: secondClose })
    const props = {
      label: 'phone',
      className: undefined,
      onSurface: () => {},
      onError: () => {},
    }
    const view = render(<PhoneH264Surface {...props} url="/first" />)
    expect(playPhoneH264Stream).toHaveBeenCalledTimes(1)

    view.rerender(<PhoneH264Surface {...props} url="/second" />)
    expect(firstClose).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
    expect(playPhoneH264Stream).toHaveBeenCalledTimes(1)

    firstSettlement.resolve()
    await act(async () => { await firstSettlement.promise })
    expect(playPhoneH264Stream).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(secondClose).toHaveBeenCalledTimes(1)
    secondSettlement.resolve()
    await secondSettlement.promise
  })
})
