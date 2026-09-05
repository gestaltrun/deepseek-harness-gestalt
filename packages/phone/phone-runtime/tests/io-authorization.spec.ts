import { describe, expect, it } from 'vitest'
import { assertIoDispatchAuthority, type IoDispatchCapture } from '../src/io-authorization.ts'

function none(): IoDispatchCapture {
  return { kind: 'none' }
}

function granted(store: { capture: object | undefined }, admitted: object): IoDispatchCapture {
  return {
    kind: 'capture',
    admitted,
    getCurrent: () => store.capture,
  }
}

describe('assertIoDispatchAuthority', () => {
  it('accepts a live incarnation match for non-capture io', () => {
    const incarnation = {}
    const store: { incarnation: object | undefined } = { incarnation }
    expect(() => {
      assertIoDispatchAuthority({
        admittedIncarnation: incarnation,
        getCurrentIncarnation: () => store.incarnation,
        capture: none(),
      })
    }).not.toThrow()
  })

  it('reads the live capture token at the check, not a snapshot taken earlier', () => {
    const incarnation = {}
    const first = {}
    const second = {}
    const store: { incarnation: object | undefined; capture: object | undefined } = {
      incarnation,
      capture: first,
    }
    const capture = granted(store, first)
    store.capture = second
    expect(() => {
      assertIoDispatchAuthority({
        admittedIncarnation: incarnation,
        getCurrentIncarnation: () => store.incarnation,
        capture,
      })
    }).toThrow(expect.objectContaining({
      code: 'PHONE_PROTOCOL',
      message: 'capture authority changed before io dispatch',
    }))
  })

  it('refuses a replaced or removed incarnation', () => {
    const admitted = {}
    const store: { incarnation: object | undefined } = { incarnation: admitted }
    const options = {
      admittedIncarnation: admitted,
      getCurrentIncarnation: () => store.incarnation,
      capture: none(),
    }
    store.incarnation = {}
    expect(() => {
      assertIoDispatchAuthority(options)
    }).toThrow(expect.objectContaining({
      code: 'PHONE_ABORTED',
      message: 'device incarnation changed before io dispatch',
    }))
    store.incarnation = undefined
    expect(() => {
      assertIoDispatchAuthority(options)
    }).toThrow(expect.objectContaining({
      code: 'PHONE_ABORTED',
      message: 'device incarnation changed before io dispatch',
    }))
  })

  it('refuses a removed admitted capture grant', () => {
    const incarnation = {}
    const capture = {}
    const store: { capture: object | undefined } = { capture }
    const arm = granted(store, capture)
    store.capture = undefined
    expect(() => {
      assertIoDispatchAuthority({
        admittedIncarnation: incarnation,
        getCurrentIncarnation: () => incarnation,
        capture: arm,
      })
    }).toThrow(expect.objectContaining({
      code: 'PHONE_PROTOCOL',
      message: 'capture authority changed before io dispatch',
    }))
  })

  it('does not consult capture liveness when the capture arm is none', () => {
    const incarnation = {}
    expect(() => {
      assertIoDispatchAuthority({
        admittedIncarnation: incarnation,
        getCurrentIncarnation: () => incarnation,
        capture: none(),
      })
    }).not.toThrow()
  })
})
