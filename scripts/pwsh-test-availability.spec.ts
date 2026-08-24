import { describe, expect, it, vi } from 'vitest'
import { TEST_REQUIRE_PWSH_ENV, testPwshAvailable } from './pwsh-test-availability.ts'

describe('PowerShell test availability', () => {
  it('honors an explicit CI requirement without repeating a process probe', () => {
    const probe = vi.fn(() => ({ status: null }))

    expect(testPwshAvailable('1', probe)).toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    [0, true],
    [1, false],
    [null, false],
  ] as const)('uses the real probe outside a required CI lane: %j', (status, expected) => {
    expect(testPwshAvailable('', () => ({ status }))).toBe(expected)
  })

  it.each(['0', 'true', 'required'])('rejects invalid requirement %j', (required) => {
    expect(() => testPwshAvailable(required, () => ({ status: 0 })))
      .toThrow(`${TEST_REQUIRE_PWSH_ENV} must be '1' or unset`)
  })
})
