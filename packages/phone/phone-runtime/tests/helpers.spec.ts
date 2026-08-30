import { access, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMobilecliAgent } from '../src/agent-process.ts'
import { MobilecliServerProcess } from '../src/server-process.ts'
import { stageFake, type StagedFake } from './helpers.ts'

const fakes: StagedFake[] = []
const processes: MobilecliServerProcess[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map(process => process.stop()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('fake mobilecli launcher', () => {
  it('stages one native Windows launcher beside the shared fake module', async () => {
    const fake = await stageFake({ agent: { installed: true } }, 'win32')
    fakes.push(fake)
    fake.claim()

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
