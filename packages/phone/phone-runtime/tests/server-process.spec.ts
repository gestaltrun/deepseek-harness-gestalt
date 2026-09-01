import { afterEach, describe, expect, it } from 'vitest'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MobilecliServerProcess, retainTail } from '../src/server-process.ts'

import { stageFake } from './helpers.ts'

const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []
const processes: MobilecliServerProcess[] = []

afterEach(async () => {
  for (const proc of processes.splice(0)) await proc.stop().catch(() => undefined)
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('MobilecliServerProcess', () => {
  it('spawns the fake, reaches liveness, and stops to exit quiescence on SIGTERM', async () => {
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

  it.runIf(process.platform === 'win32')('reaches quiescence when Windows terminates the native launcher on SIGTERM', async () => {
    const fake = await stageFake({ ignoreTerm: true })
    fakes.push(fake)
    await fake.claim()
    const proc = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(proc)
    await fake.awaitOnline()
    await proc.stop()
    const exit = await proc.exit
    expect(exit.signal).toBe('SIGTERM')
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
