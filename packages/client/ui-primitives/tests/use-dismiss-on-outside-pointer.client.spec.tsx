// @vitest-environment jsdom
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useDismissOnOutsidePointer } from '../src/useDismissOnOutsidePointer.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Host(props: { open: boolean; setOpen: (open: boolean) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(rootRef, props.open, props.setOpen, portalRef)
  return (
    <>
      <div ref={rootRef} data-testid="root" />
      <div ref={portalRef} data-testid="portal" />
    </>
  )
}

describe('useDismissOnOutsidePointer', () => {
  it('attaches only while open and dismisses outside both owned elements', () => {
    const setOpen = vi.fn()
    const view = render(<Host open={false} setOpen={setOpen} />)

    fireEvent.pointerDown(document.body)
    expect(setOpen).not.toHaveBeenCalled()

    view.rerender(<Host open setOpen={setOpen} />)
    fireEvent.pointerDown(view.getByTestId('root'))
    fireEvent.pointerDown(view.getByTestId('portal'))
    expect(setOpen).not.toHaveBeenCalled()

    fireEvent.pointerDown(document.body)
    expect(setOpen).toHaveBeenCalledWith(false)

    view.rerender(<Host open={false} setOpen={setOpen} />)
    fireEvent.pointerDown(document.body)
    expect(setOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores an event target that is not a DOM Node', () => {
    const setOpen = vi.fn()
    const add = vi.spyOn(document, 'addEventListener')
    render(<Host open setOpen={setOpen} />)
    const listener = add.mock.calls.find(([type]) => type === 'pointerdown')?.[1]
    if (typeof listener !== 'function') throw new Error('pointerdown listener was not registered')

    listener({ target: window } as unknown as PointerEvent)

    expect(setOpen).not.toHaveBeenCalled()
  })
})
