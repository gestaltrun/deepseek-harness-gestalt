import { describe, expect, it } from 'vitest'
import { phoneCaptureId } from '@deepseek-ai/dsh-phone-runtime'
import { CaptureGrantLedger } from '../src/capture-grant-ledger.ts'

describe('CaptureGrantLedger', () => {
  it('prunes expired spent ownership without restoring replay', () => {
    const ledger = new CaptureGrantLedger()
    const first = phoneCaptureId('first')
    const second = phoneCaptureId('second')
    expect(ledger.consume(first, 10, 1)).toBe(true)
    expect(ledger.consume(first, 10, 2)).toBe(false)
    expect(ledger.consume(first, 10, 10)).toBe(false)
    expect(ledger.ownershipSnapshot()).toBe(1)
    expect(ledger.consume(second, 20, 11)).toBe(true)
    expect(ledger.ownershipSnapshot()).toBe(1)
  })
})
