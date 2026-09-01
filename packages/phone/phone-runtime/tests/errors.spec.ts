import { describe, expect, it } from 'vitest'
import { phoneFailureWithCleanup, PhoneDevicesError } from '../src/errors.ts'

describe('phone failure cleanup facts', () => {
  it.each([
    new Error('cleanup refused'),
    'non-error cleanup refusal',
  ])('preserves the operation code while retaining cleanup failure %s', (cleanup) => {
    const operation = new PhoneDevicesError('PHONE_TIMEOUT', 'operation timed out')

    const combined = phoneFailureWithCleanup(operation, cleanup, 'runtime cleanup failed')

    expect(combined.code).toBe('PHONE_TIMEOUT')
    expect(combined.message).toContain('operation timed out')
    expect(combined.message).toContain(cleanup instanceof Error ? cleanup.message : cleanup)
    expect(combined.cause).toBeInstanceOf(AggregateError)
    expect((combined.cause as AggregateError).errors).toEqual([operation, cleanup])
  })

  it('preserves a structured real-device issue', () => {
    const operation = new PhoneDevicesError(
      'PHONE_REAL_DEVICE_ISSUE',
      'unlock the device',
      { issue: 'device-locked' },
    )

    const combined = phoneFailureWithCleanup(operation, new Error('cleanup refused'), 'runtime cleanup failed')

    expect(combined.issue).toBe('device-locked')
  })
})
