import { access, stat } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMobilecliAgent } from '../src/agent-process.ts'
import { MobilecliServerProcess } from '../src/server-process.ts'
import { stageFake, type StagedFake } from './helpers.ts'

const fakes: StagedFake[] = []
const processes: MobilecliServerProcess[] = []

async function bindOnce(port: number): Promise<void> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

afterEach(async () => {
  await Promise.all(processes.splice(0).map(process => process.stop()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('fake mobilecli launcher', () => {
  it('releases an unclaimed port reservation before disposal settles', async () => {
    const fake = await stageFake()
    try {
      await fake.dispose()

      await expect(bindOnce(fake.port)).resolves.toBeUndefined()
    } finally {
      await fake.claim()
      await fake.dispose()
    }
  })

  it('reuses one settled reservation release across claim and disposal', async () => {
    const fake = await stageFake()
    try {
      const firstRelease = fake.claim()
      const repeatedRelease = fake.claim()
      expect(firstRelease).toBeInstanceOf(Promise)
      expect(repeatedRelease).toBe(firstRelease)
      await firstRelease
      await fake.dispose()
      await fake.dispose()

      await expect(bindOnce(fake.port)).resolves.toBeUndefined()
    } finally {
      await fake.dispose()
    }
  })

  it('stages one native Windows launcher beside the shared fake module', async () => {
    const fake = await stageFake({ agent: { installed: true } }, 'win32')
    fakes.push(fake)
    await fake.claim()

    expect(fake.executablePath).toMatch(/fakemobilecli\.exe$/i)
    expect((await stat(fake.executablePath)).size).toBe((await stat(process.execPath)).size)
    expect(process.env.NODE_OPTIONS).toContain('fakemobilecli-bootstrap.mjs')
    await expect(access(join(dirname(fake.executablePath), 'fakemobilecli.mjs'))).resolves.toBeUndefined()

    const server = new MobilecliServerProcess({ executablePath: fake.executablePath, port: fake.port })
    processes.push(server)
    await fake.awaitOnline()
    expect(server.lastStderr).toContain('listening')
    await server.stop()
    expect(server.alive).toBe(false)

    const agent = await runMobilecliAgent({
      executablePath: fake.executablePath,
      args: ['agent', 'status', '--device', 'fixture-device'],
      signal: undefined,
      timeoutMs: 2_000,
    })
    expect(agent.ok).toBe(true)
  })
})
