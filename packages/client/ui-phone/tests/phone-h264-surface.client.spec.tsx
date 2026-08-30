// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const playPhoneH264Stream = vi.hoisted(() => vi.fn())

vi.mock('../src/client/phone-h264-playback.ts', () => ({ playPhoneH264Stream }))

import { PhoneH264PlaybackOwner, PhoneH264Surface } from '../src/client/PhoneH264Surface.tsx'

afterEach(() => { vi.restoreAllMocks() })

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve: () => { resolve?.() } }
}

function ConnectedOwnerHarness({ url }: { readonly url: string | undefined }): ReactNode {
  const owner = useRef<PhoneH264PlaybackOwner | undefined>(undefined)
  owner.current ??= new PhoneH264PlaybackOwner()
  if (url === undefined) return null
  return (
    <PhoneH264Surface
      owner={owner.current}
      url={url}
      label="phone"
      className={undefined}
      onSurface={() => {}}
      onError={() => {}}
    />
  )
}

describe('PhoneH264Surface playback ownership', () => {
  it('keeps quiescence across unmount and skips an obsolete middle generation', async () => {
    const firstSettlement = deferred()
    const secondSettlement = deferred()
    const firstClose = vi.fn(() => firstSettlement.promise)
    const secondClose = vi.fn(() => secondSettlement.promise)
    playPhoneH264Stream
      .mockReturnValueOnce({ close: firstClose })
      .mockReturnValueOnce({ close: secondClose })
    const view = render(<ConnectedOwnerHarness url="/device-a" />)
    expect(playPhoneH264Stream).toHaveBeenCalledTimes(1)

    view.rerender(<ConnectedOwnerHarness url={undefined} />)
    expect(firstClose).toHaveBeenCalledTimes(1)
    view.rerender(<ConnectedOwnerHarness url="/device-b" />)
    await act(async () => { await Promise.resolve() })
    expect(playPhoneH264Stream).toHaveBeenCalledTimes(1)
    view.rerender(<ConnectedOwnerHarness url="/device-c" />)

    firstSettlement.resolve()
    await act(async () => { await firstSettlement.promise })
    expect(playPhoneH264Stream).toHaveBeenCalledTimes(2)
    expect(playPhoneH264Stream.mock.calls[1]?.[0]).toMatchObject({ url: '/device-c' })

    view.unmount()
    expect(secondClose).toHaveBeenCalledTimes(1)
    secondSettlement.resolve()
    await secondSettlement.promise
  })
})
