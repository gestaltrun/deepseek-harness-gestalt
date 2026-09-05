import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { awaitMobilecliTreeExit, MobilecliServerProcess, retainTail, type MobilecliTreeJoin, type ServerExit } from '../src/server-process.ts'
import { PhoneDevicesError } from '../src/errors.ts'

import { stageFake } from './helpers.ts'

const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []
const processes: MobilecliServerProcess[] = []

afterEach(async () => {
  for (const proc of processes.splice(0)) await proc.stop().catch(() => undefined)
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('MobilecliServerProcess', () => {
  it.skipIf(process.platform === 'win32')('spawns the fake, reaches liveness, and stops to exit quiescence on SIGTERM', async () => {
    const fake = await stageFake()
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    expect(proc.alive).toBe(true)
    await fake.awaitOnline()
    expect(proc.lastStderr).toContain('listening')
    await proc.stop()
    expect(proc.alive).toBe(false)
    const exit = await proc.exit
    expect(exit.code).toBeNull()
    expect(exit.signal).toBe('SIGTERM')
  }, 15_000)

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const fake = await stageFake({ ignoreTerm: true })
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    await proc.stop()
    const exit = await proc.exit
    expect(exit.signal).toBe('SIGKILL')
    expect(proc.alive).toBe(false)
  }, 15_000)

  it.skipIf(process.platform === 'win32')('stops the official-style Node launcher and its native descendant', async () => {
    const fake = await stageFake()
    fakes.push(fake)
    await fake.claim()
    const fixtureDir = dirname(fake.executablePath)
    const launcher = join(fixtureDir, 'mobilecli-launcher')
    const descendantPidFile = join(fixtureDir, 'descendant.pid')
    await writeFile(launcher, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(${JSON.stringify(fake.executablePath)}, process.argv.slice(2), { stdio: 'inherit' })
writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid))
child.on('close', code => { process.exit(code ?? 1) })
`)
    await chmod(launcher, 0o755)
    const proc = new MobilecliServerProcess({ executablePath: launcher, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    const descendantPid = Number(await readFile(descendantPidFile, 'utf8'))

    try {
      await proc.stop()
      await expect(fetch(fake.baseUrl)).rejects.toThrow()
    } finally {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }, 15_000)

  it.runIf(process.platform === 'win32')('reaches quiescence after Windows forcibly terminates the native launcher', async () => {
    const fake = await stageFake({ ignoreTerm: true })
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    await proc.stop()
    const exit = await proc.exit
    expect(exit).toEqual({ code: 1 })
    expect(proc.alive).toBe(false)
  }, 15_000)

  it('bounds the retained stderr tail', () => {
    const tail = retainTail('a'.repeat(4_100), 'z')
    expect(tail.length).toBe(4_096)
    expect(tail.endsWith('z')).toBe(true)
  })

  it('bounds its diagnostic ring', () => {
    for (let index = 0; index < 60; index += 1) {
      MobilecliServerProcess.record(`line-${String(index)}`)
    }
    expect(MobilecliServerProcess.diagnostics.length).toBeLessThanOrEqual(40)
    expect(MobilecliServerProcess.diagnostics.at(-1)).toBe('line-59')
    MobilecliServerProcess.diagnostics.splice(0)
  })

  it('joins abort-driven tree stop through awaitMobilecliTreeExit', async () => {
    const fake = await stageFake()
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    const budget = new AbortController()
    const joining = awaitMobilecliTreeExit(proc, budget.signal, () => new PhoneDevicesError('PHONE_ABORTED', 'probe cancelled'))
    budget.abort()
    await expect(joining).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(proc.alive).toBe(false)
  })

  it('publishes stop for an already-aborted budget without waiting for natural exit', async () => {
    const fake = await stageFake()
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    const budget = new AbortController()
    budget.abort()
    await expect(awaitMobilecliTreeExit(
      proc,
      budget.signal,
      () => new PhoneDevicesError('PHONE_ABORTED', 'probe cancelled'),
    )).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(proc.alive).toBe(false)
  })

  it('surfaces abort-driven tree.stop rejection before halt classification', async () => {
    const fake = await stageFake()
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    const originalStop = proc.stop.bind(proc)
    const stop = vi.spyOn(proc, 'stop').mockImplementation(async () => {
      await originalStop()
      throw new Error('tree cleanup refused')
    })
    try {
      const budget = new AbortController()
      const joining = awaitMobilecliTreeExit(
        proc,
        budget.signal,
        () => new PhoneDevicesError('PHONE_ABORTED', 'probe cancelled'),
      )
      budget.abort()
      await expect(joining).rejects.toThrow('tree cleanup refused')
    } finally {
      stop.mockRestore()
    }
  })

  it('settles its exit promise even when the executable never exists', async () => {
    const proc = new MobilecliServerProcess({ executablePath: '/dsh-phone-no-such-binary', port: 45_671 })
    processes.push(proc)
    const exit = await proc.exit
    expect(exit.code).toBeNull()
    expect(proc.alive).toBe(false)
    expect(proc.lastStderr).toContain('spawn failed')
    await proc.stop()
  })
})

describe('awaitMobilecliTreeExit', () => {
  const halt = (): PhoneDevicesError => new PhoneDevicesError('PHONE_ABORTED', 'probe cancelled')

  function fakeJoin(stopImpl: (settleExit: (exit?: ServerExit) => void) => Promise<void> | void): {
    readonly tree: MobilecliTreeJoin
    readonly stop: ReturnType<typeof vi.fn>
    settleExit(exit?: ServerExit): void
  } {
    const exit = Promise.withResolvers<ServerExit>()
    const settleExit = (value: ServerExit = { code: 0 }): void => {
      exit.resolve(value)
    }
    const stop = vi.fn(() => {
      const result = stopImpl(settleExit)
      return result instanceof Promise ? result : Promise.resolve()
    })
    return {
      tree: { exit: exit.promise, stop: () => stop() },
      stop,
      settleExit,
    }
  }

  it('invokes exactly one stop for a pre-aborted budget', async () => {
    const budget = new AbortController()
    budget.abort()
    const join = fakeJoin(async (settleExit) => {
      settleExit({ code: null })
    })
    await expect(awaitMobilecliTreeExit(join.tree, budget.signal, halt)).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(join.stop).toHaveBeenCalledTimes(1)
  })

  it('publishes one abort-driven stop and then halt', async () => {
    const budget = new AbortController()
    const join = fakeJoin(async (settleExit) => {
      settleExit({ code: null })
    })
    const joining = awaitMobilecliTreeExit(join.tree, budget.signal, halt)
    budget.abort()
    await expect(joining).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(join.stop).toHaveBeenCalledTimes(1)
  })

  it('contains a synchronous stop throw before halt classification', async () => {
    const budget = new AbortController()
    const join = fakeJoin(() => {
      throw new Error('sync stop refused')
    })
    const joining = awaitMobilecliTreeExit(join.tree, budget.signal, halt)
    budget.abort()
    await expect(joining).rejects.toThrow('sync stop refused')
    expect(join.stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces an async stop rejection before halt classification', async () => {
    const budget = new AbortController()
    const join = fakeJoin(async () => {
      throw new Error('async stop refused')
    })
    const joining = awaitMobilecliTreeExit(join.tree, budget.signal, halt)
    budget.abort()
    await expect(joining).rejects.toThrow('async stop refused')
    expect(join.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps a nested budget.abort during async stop from starting a second stop', async () => {
    const budget = new AbortController()
    const join = fakeJoin(async (settleExit) => {
      budget.abort()
      settleExit({ code: null })
    })
    const joining = awaitMobilecliTreeExit(join.tree, budget.signal, halt)
    budget.abort()
    await expect(joining).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(join.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps a nested budget.abort during sync stop from starting a second stop', async () => {
    const budget = new AbortController()
    const join = fakeJoin((settleExit) => {
      budget.abort()
      settleExit({ code: null })
    })
    const joining = awaitMobilecliTreeExit(join.tree, budget.signal, halt)
    budget.abort()
    await expect(joining).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(join.stop).toHaveBeenCalledTimes(1)
  })

  it('removes the abort listener on every path including success', async () => {
    const budget = new AbortController()
    const removed = vi.spyOn(budget.signal, 'removeEventListener')
    const join = fakeJoin(async () => {
      throw new Error('late stop must not run')
    })
    join.settleExit({ code: 0 })
    await expect(awaitMobilecliTreeExit(join.tree, budget.signal, halt)).resolves.toEqual({ code: 0 })
    expect(removed).toHaveBeenCalled()
    budget.abort()
    expect(join.stop).not.toHaveBeenCalled()
  })

  it('returns child exit without stopping when the budget never aborts', async () => {
    const budget = new AbortController()
    const join = fakeJoin(async () => {
      throw new Error('success path must not stop')
    })
    join.settleExit({ code: 0 })
    await expect(awaitMobilecliTreeExit(join.tree, budget.signal, halt)).resolves.toEqual({ code: 0 })
    expect(join.stop).not.toHaveBeenCalled()
  })
})
