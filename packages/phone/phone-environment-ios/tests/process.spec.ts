import { describe, expect, it } from 'vitest'
import { createNodeIosCommandRunner } from '../src/process.ts'

describe('iOS command runner', () => {
  it('spawns directly with a scrubbed environment and reports exit facts independently', async () => {
    const runner = createNodeIosCommandRunner()
    const previous = process.env.DSH_TEST_SECRET
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const result = await runner.run(process.execPath, ['-e', [
        "process.stdout.write(process.env.DSH_TEST_SECRET ?? 'missing')",
        "process.stderr.write('diagnostic')",
        'process.exitCode = 7',
      ].join(';')], { env: { PATH: process.env.PATH ?? '' } })
      expect(result).toEqual({
        code: 7, signal: null, timedOut: false, stdout: 'missing', stderr: 'diagnostic',
      })
    } finally {
      if (previous === undefined) delete process.env.DSH_TEST_SECRET
      else process.env.DSH_TEST_SECRET = previous
    }
  })

  it('terminates a timed-out process group and retains both timeout and exit facts', async () => {
    const runner = createNodeIosCommandRunner()
    const result = await runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '' }, timeoutMs: 25,
    })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGTERM')
    expect(result.code).toBeNull()
  })
})
