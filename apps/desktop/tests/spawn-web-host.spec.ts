import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { redactWebHostDiagnostic, spawnWebHost, type RunningWebHost } from '../src/spawn-web-host.ts'

const here = dirname(fileURLToPath(import.meta.url))
const children: RunningWebHost[] = []

afterEach(async () => {
  await Promise.all(children.map(async running => running.stop()))
  children.length = 0
})

describe('spawnWebHost', () => {
  it('redacts credential values from startup diagnostics', () => {
    const output = [
      'provider key: exact-secret-value',
      'SERVICE_TOKEN=dynamic-token',
      'fetch https://user:password@example.test failed',
    ].join('\n')

    const diagnostic = redactWebHostDiagnostic(output, { PROVIDER_API_KEY: 'exact-secret-value' })

    expect(diagnostic).not.toContain('exact-secret-value')
    expect(diagnostic).not.toContain('dynamic-token')
    expect(diagnostic).not.toContain('user:password')
    expect(diagnostic).toContain('[REDACTED]')
  })

  it('resolves the loopback URL from mixed stdout', async () => {
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-url.mjs')],
      cwd: here,
    }, 5_000)
    children.push(running)
    expect(running.url).toBe('http://127.0.0.1:34567')
    expect(running.child.exitCode).toBeNull()
  })

  it('rejects when the child exits before announcing a URL', async () => {
    await expect(spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'exit-before-url.mjs')],
      cwd: here,
    }, 5_000)).rejects.toThrow(/exited before announcing a URL/)
  })

  it('stops the child and waits for process exit', async () => {
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-url.mjs')],
      cwd: here,
    }, 5_000)
    children.push(running)

    await running.stop()

    expect(running.child.exitCode ?? running.child.signalCode).not.toBeNull()
  })

  it('aborts a startup wait only after the unannounced child exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-abort-'))
    const pidFile = join(dir, 'pid')
    const controller = new AbortController()
    const outcome: Promise<Error | undefined> = spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'wait-for-url.mjs')],
      cwd: here,
      env: { DSH_TEST_PID_FILE: pidFile },
      signal: controller.signal,
    }, 5_000).then(() => undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    const pid = await waitForPid(pidFile)

    controller.abort()
    expect((await outcome)?.message).toContain('aborted')
    expect(processExists(pid)).toBe(false)
  })

  it('times out only after the unannounced child exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-timeout-'))
    const pidFile = join(dir, 'pid')
    const outcome: Promise<Error | undefined> = spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'wait-for-url.mjs')],
      cwd: here,
      env: { DSH_TEST_PID_FILE: pidFile },
    }, 1_000).then(() => undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    const pid = await waitForPid(pidFile)

    expect((await outcome)?.message).toContain('within 1000ms')
    expect((await outcome)?.message).toContain('fixture waiting without a URL')
    expect(processExists(pid)).toBe(false)
  })

  it('redacts child credential output from timeout errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-timeout-redaction-'))
    const pidFile = join(dir, 'pid')
    const outcome: Promise<Error | undefined> = spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'wait-for-url.mjs')],
      cwd: here,
      env: { DSH_TEST_PID_FILE: pidFile, DSH_TEST_API_KEY: 'fixture-secret-value' },
    }, 1_000).then(() => undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    await waitForPid(pidFile)

    const message = (await outcome)?.message ?? ''
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain('fixture-secret-value')
  })
})

async function waitForPid(path: string): Promise<number> {
  await expect.poll(async () => {
    try {
      return (await readFile(path, 'utf8')).trim().length > 0
    } catch {
      return false
    }
  }).toBe(true)
  return Number((await readFile(path, 'utf8')).trim())
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
