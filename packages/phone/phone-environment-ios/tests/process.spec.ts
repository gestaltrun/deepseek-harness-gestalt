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

  it('retains complete simctl JSON larger than the legacy diagnostic tail', async () => {
    const payload = JSON.stringify({ devicetypes: Array.from({ length: 1_200 }, (_, index) => ({
      identifier: `com.apple.CoreSimulator.SimDeviceType.iPhone-${String(index)}`,
      name: `iPhone ${String(index)}`,
    })) })
    expect(Buffer.byteLength(payload)).toBeGreaterThan(16_384)
    const result = await createNodeIosCommandRunner().run(
      process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload],
      { env: { PATH: process.env.PATH ?? '' }, stdoutMaxBytes: 1024 * 1024 },
    )
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(payload))
  })

  it.skipIf(process.platform === 'win32')('fails loud when stdout crosses its explicit ceiling', async () => {
    const result = await createNodeIosCommandRunner({ stopGraceMs: 10 }).run(
      process.execPath, ['-e', 'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)'],
      { env: { PATH: process.env.PATH ?? '' }, stdoutMaxBytes: 1024 },
    )
    expect(result.terminationError).toMatch(/stdout exceeded 1024 bytes/u)
  })

  it.skipIf(process.platform === 'win32')('bounds a child that ignores both termination phases', async () => {
    let pid: number | undefined
    const runner = createNodeIosCommandRunner({
      stopGraceMs: 5,
      killProcessGroup: (value) => { pid = value },
    })
    const result = await runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5,
    })
    expect(result).toMatchObject({ timedOut: true, code: null, signal: null })
    expect(result.terminationError).toMatch(/did not exit after forced termination/u)
    if (pid !== undefined) process.kill(-pid, 'SIGKILL')
  })

  it.skipIf(process.platform === 'win32')('contains process-group termination failures in the result', async () => {
    let pid: number | undefined
    const runner = createNodeIosCommandRunner({
      stopGraceMs: 5,
      killProcessGroup: (value) => { pid = value; throw new Error('kill refused process group') },
    })
    const result = await runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5,
    })
    expect(result.terminationError).toBe('kill refused process group')
    if (pid !== undefined) process.kill(-pid, 'SIGKILL')
  })
})
