import { describe, expect, it, vi } from 'vitest'

import { runWithTransientRetry } from './retry-transient-ci.ts'

function attempt(
  exitCode: number,
  classification: 'transient-infrastructure' | null,
  attemptNumber: 1 | 2 = 1,
) {
  return { attempt: attemptNumber, exitCode, signalCode: null, classification }
}

describe('transient CI retry', () => {
  it('does not retry a successful command', async () => {
    const execute = vi.fn().mockResolvedValue(attempt(0, null))

    const result = await runWithTransientRetry('docker', ['pull', 'image'], execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(result.evidence).toMatchObject({ status: 'passed', retried: false })
  })

  it('does not retry an ordinary product failure', async () => {
    const execute = vi.fn().mockResolvedValue(attempt(1, null))

    const result = await runWithTransientRetry('pnpm', ['test'], execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(result.evidence).toMatchObject({ status: 'failed', retried: false })
  })

  it('records both attempts for one transient infrastructure retry', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(attempt(1, 'transient-infrastructure'))
      .mockResolvedValueOnce(attempt(0, null, 2))

    const result = await runWithTransientRetry('docker', ['pull', 'image'], execute)

    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.evidence).toMatchObject({ status: 'passed', retried: true })
    expect(result.evidence.attempts).toHaveLength(2)
  })
})
