import { describe, expect, it } from 'vitest'
import {
  phoneRuntimeStateReader,
  phoneRuntimeStateValidator,
  registerPhoneRuntimeStateReader,
  registerPhoneRuntimeStateValidator,
  type PhoneRuntimeStateOwner,
} from '../src/runtime-state.ts'

const owner = {} as PhoneRuntimeStateOwner
const ownerB = {} as PhoneRuntimeStateOwner

describe('runtime-state registries', () => {
  it('allows exactly one reader per generation and honors its disposer', () => {
    const read = (): undefined => undefined
    const dispose = registerPhoneRuntimeStateReader(owner, read)
    expect(phoneRuntimeStateReader(owner)).toBe(read)
    expect(() => registerPhoneRuntimeStateReader(owner, read)).toThrow(/already registered a state reader/)
    dispose()
    expect(phoneRuntimeStateReader(owner)).toBeUndefined()
  })

  it('ignores stale disposers after a replacement registration', () => {
    const firstRead = (): undefined => undefined
    const disposeFirst = registerPhoneRuntimeStateReader(owner, firstRead)
    disposeFirst()
    const secondRead = (): undefined => undefined
    const disposeSecond = registerPhoneRuntimeStateReader(owner, secondRead)
    disposeFirst()
    expect(phoneRuntimeStateReader(owner)).toBe(secondRead)
    disposeSecond()
    expect(phoneRuntimeStateReader(owner)).toBeUndefined()
  })

  it('requires a reader before a validator seat and allows one validator', () => {
    expect(() => registerPhoneRuntimeStateValidator(ownerB, () => undefined)).toThrow(/no state reader/)
    registerPhoneRuntimeStateReader(ownerB, () => undefined)
    const validate = (): undefined => undefined
    const dispose = registerPhoneRuntimeStateValidator(ownerB, validate)
    expect(phoneRuntimeStateValidator(ownerB)).toBe(validate)
    expect(() => registerPhoneRuntimeStateValidator(ownerB, validate)).toThrow(/already registered a state validator/)
    dispose()
    expect(phoneRuntimeStateValidator(ownerB)).toBeUndefined()
  })

  it('ignores stale validator disposers after a replacement registration', () => {
    registerPhoneRuntimeStateReader(owner, () => undefined)
    const first = registerPhoneRuntimeStateValidator(owner, () => undefined)
    first()
    const second = registerPhoneRuntimeStateValidator(owner, () => undefined)
    first()
    expect(phoneRuntimeStateValidator(owner)).not.toBeUndefined()
    second()
    expect(phoneRuntimeStateValidator(owner)).toBeUndefined()
  })
})
