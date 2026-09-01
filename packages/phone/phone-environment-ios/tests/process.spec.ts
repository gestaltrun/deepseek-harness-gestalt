import { describe, expect, it, vi } from 'vitest'
import { createNodeIosCommandRunner } from '../src/process.ts'

describe('iOS command runner', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid stdoutMaxBytes %s', async (stdoutMaxBytes) => {
    await expect(createNodeIosCommandRunner().run(process.execPath, ['-e', ''], {
      env: { PATH: process.env.PATH ?? '' }, stdoutMaxBytes,
    })).rejects.toThrow(TypeError)
  })

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

  it.skipIf(process.platform === 'win32')('terminates a timed-out process group and retains both timeout and exit facts', async () => {
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
      process.execPath, ['-e', [
        'const devicetypes = Array.from({ length: 1200 }, (_, index) => ({',
        '  identifier: `com.apple.CoreSimulator.SimDeviceType.iPhone-${String(index)}`,',
        '  name: `iPhone ${String(index)}`,',
        '}))',
        'process.stdout.write(JSON.stringify({ devicetypes }))',
      ].join('\n')],
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

  it.skipIf(process.platform === 'win32')('normalizes non-Error termination failures and ignores later stdout', async () => {
    let pid: number | undefined
    const controller = new AbortController()
    const runner = createNodeIosCommandRunner({
      stopGraceMs: 5,
      killProcessGroup: (value) => { pid = value; throw 'kill failed' },
    })
    const operation = runner.run(process.execPath, ['-e', [
      'process.stdout.write("before")',
      'setTimeout(() => process.stdout.write("late"), 400)',
    ].join(';')], {
      env: { PATH: process.env.PATH ?? '' }, signal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    controller.abort()
    const result = await operation
    expect(result.terminationError).toBe('iOS process termination failed with a non-Error reason')
    expect(result.stdout).toBe('before')
    if (pid !== undefined) process.kill(-pid, 'SIGKILL')
  })

  it.skipIf(process.platform === 'win32')('contains an already-gone process group and deduplicates termination timers', async () => {
    const controller = new AbortController()
    const runner = createNodeIosCommandRunner({
      stopGraceMs: 100,
      killProcessGroup: () => {
        const gone = new Error('already gone') as NodeJS.ErrnoException
        gone.code = 'ESRCH'
        throw gone
      },
    })
    const operation = runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], {
      env: { PATH: process.env.PATH ?? '' }, signal: controller.signal, timeoutMs: 5,
    })
    controller.abort()
    const result = await operation
    expect(result.timedOut).toBe(true)
    expect(result.terminationError).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('ignores stdout delivered after the byte ceiling already failed', async () => {
    const result = await createNodeIosCommandRunner({
      stopGraceMs: 500,
      killProcessGroup: () => {},
    }).run(process.execPath, ['-e', [
      'process.stdout.write("a".repeat(2048))',
      'setTimeout(() => process.stdout.write("b".repeat(2048)), 20)',
    ].join(';')], {
      env: { PATH: process.env.PATH ?? '' }, stdoutMaxBytes: 1024,
    })
    expect(result.terminationError).toMatch(/stdout exceeded 1024 bytes/u)
    expect(result.stdout).toBe('')
  })

  it.skipIf(process.platform === 'win32')('rejects a command that cannot spawn even when cancellation races its error event', async () => {
    const controller = new AbortController()
    const operation = createNodeIosCommandRunner().run('/path/that/does/not/exist/dsh-ios-command', [], {
      env: { PATH: process.env.PATH ?? '' }, signal: controller.signal,
    })
    controller.abort()
    await expect(operation).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('observes an abort that lands between the initial check and listener registration', async () => {
    const controller = new AbortController()
    const aborted = vi.spyOn(controller.signal, 'aborted', 'get').mockReturnValue(true)
    const throwIfAborted = vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {})
    const result = await createNodeIosCommandRunner().run(process.execPath, ['-e', ''], {
      env: { PATH: process.env.PATH ?? '' }, signal: controller.signal,
    })
    expect(result.signal).toBe('SIGTERM')
    aborted.mockRestore()
    throwIfAborted.mockRestore()
  })

  it('retains only the bounded stderr tail', async () => {
    const result = await createNodeIosCommandRunner().run(
      process.execPath, ['-e', 'process.stderr.write("x".repeat(20000))'],
      { env: { PATH: process.env.PATH ?? '' } },
    )
    expect(Buffer.byteLength(result.stderr)).toBe(16_384)
  })

  it('retains a byte-bounded stderr tail without splitting UTF-8 characters', async () => {
    const result = await createNodeIosCommandRunner().run(
      process.execPath,
      ['-e', 'process.stderr.write(String.fromCodePoint(0x1f642).repeat(4097) + "x")'],
      { env: { PATH: process.env.PATH ?? '' } },
    )
    expect(result.stderr).toBe(`${'🙂'.repeat(4095)}x`)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16_384)
    expect(result.stderr).not.toContain('\uFFFD')
  })
})
