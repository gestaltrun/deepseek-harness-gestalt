import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  redactWebHostDiagnostic, spawnWebHost, type RunningWebHost, webHostDiagnosticSummary,
} from '../src/spawn-web-host.ts'

const here = dirname(fileURLToPath(import.meta.url))
const children: RunningWebHost[] = []

afterEach(async () => {
  await Promise.all(children.map(async running => stopFixtureHost(running)))
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

  it('redacts before truncating across a credential boundary', () => {
    const secret = 'credential-prefix-and-visible-suffix'
    const output = `SERVICE_API_KEY=${secret}\n${'x'.repeat(900)}\ntail diagnostic`

    const diagnostic = webHostDiagnosticSummary(output, { SERVICE_API_KEY: secret })

    expect(diagnostic).not.toContain('visible-suffix')
    expect(diagnostic).toContain('[REDACTED]')
    expect(diagnostic).toContain('tail diagnostic')
    expect(diagnostic.length).toBeLessThanOrEqual(800)
  })

  it('does not leak a secret prefix when raw output would split at the 398-byte head', () => {
    const secret = 'fixture-secret-abcdefgh'
    const env = { TEST_API_KEY: secret }
    const input = `${'x'.repeat(390)}${secret}${'z'.repeat(1000)}`
    const summarized = webHostDiagnosticSummary(input, env)
    expect(summarized).not.toContain('fixture-')
    expect(summarized).not.toContain(secret)
  })

  it('masks an incomplete trailing known-secret prefix when the Host dies mid-secret', () => {
    const secret = 'fixture-secret-abcdefgh'
    const prefix12 = secret.slice(0, 12)
    const summarized = webHostDiagnosticSummary(`prefix ${prefix12}`, { TEST_API_KEY: secret })
    expect(summarized).not.toContain(prefix12)
    expect(summarized).not.toContain('fixture-')
    expect(summarized).toContain('[REDACTED]')
  })

  it('does not emit an overlong TOKEN continuation as a later line after the assignment', () => {
    const summarized = webHostDiagnosticSummary(
      `SERVICE_TOKEN=${'x'.repeat(900)}sensitiveSuffix\nsafe-next-line`,
      {},
    )
    expect(summarized).not.toContain('sensitiveSuffix')
    expect(summarized).toContain('safe-next-line')
    expect(summarized).toContain('SERVICE_TOKEN=[REDACTED]')
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

  it('records an immutable post-ready exit with pid, code 1, and unsolicited origin', async () => {
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-then-exit-1.mjs')],
      cwd: here,
    }, 5_000)
    children.push(running)
    const record = await running.exited
    expect(Object.isFrozen(record)).toBe(true)
    expect(record.pid).toBe(running.child.pid)
    expect(record.code).toBe(1)
    expect(record.signal).toBeNull()
    expect(record.requestedStop).toEqual({ kind: 'none' })
  })

  it('captures requestedStop stop before kill', async () => {
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-then-secret.mjs')],
      cwd: here,
    }, 5_000)
    children.push(running)
    const record = await running.stop()
    expect(Object.isFrozen(record)).toBe(true)
    expect(record.pid).toBe(running.child.pid)
    expect(record.requestedStop).toEqual({ kind: 'stop' })
    expect(record.code === null && record.signal === null).toBe(false)
    expect(Object.hasOwn(record, 'tail')).toBe(false)
  })

  it('records abort after the URL is announced as distinct from stop', async () => {
    const controller = new AbortController()
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-then-secret.mjs')],
      cwd: here,
      signal: controller.signal,
    }, 5_000)
    children.push(running)
    try {
      controller.abort()
      const record = await Promise.race([
        running.exited,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('post-ready abort did not join child exit')) }, 1_000)
        }),
      ])
      expect(record.requestedStop).toEqual({ kind: 'abort' })
      expect(record.requestedStop).not.toEqual({ kind: 'stop' })
    } finally {
      await running.stop()
    }
  })

  it('records abort as the first cause when startup is aborted before the URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-abort-cause-'))
    const pidFile = join(dir, 'pid')
    const controller = new AbortController()
    const pending = spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'wait-for-url.mjs')],
      cwd: here,
      env: { DSH_TEST_PID_FILE: pidFile },
      signal: controller.signal,
    }, 5_000)
    const pid = await waitForPid(pidFile)
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    expect(processExists(pid)).toBe(false)
  })

  it('contains a post-ready abort when kill throws', async () => {
    const controller = new AbortController()
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-url.mjs')],
      cwd: here,
      signal: controller.signal,
    }, 5_000)
    children.push(running)
    const pid = running.child.pid
    const nativeKill = running.child.kill.bind(running.child)
    running.child.kill = () => { throw new Error('kill refused') }
    try {
      controller.abort()
      await expect(running.stop()).rejects.toThrow('kill refused')
    } finally {
      running.child.kill = nativeKill
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL') } catch { /* child may already have exited */ }
      }
    }
  })

  it('rejects a memoized stop when kill throws and reentry shares that rejection', async () => {
    const running = await spawnWebHost({
      node: process.execPath,
      args: [join(here, 'fixtures', 'announce-url.mjs')],
      cwd: here,
    }, 5_000)
    const pid = running.child.pid
    const nativeKill = running.child.kill.bind(running.child)
    running.child.kill = () => { throw new Error('kill refused') }
    try {
      const first = running.stop()
      const second = running.stop()
      expect(second).toBe(first)
      await expect(first).rejects.toThrow('kill refused')
      await expect(second).rejects.toThrow('kill refused')
    } finally {
      running.child.kill = nativeKill
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL') } catch { /* child may already have exited */ }
      }
    }
  })

})

async function stopFixtureHost(running: RunningWebHost): Promise<void> {
  try {
    await running.stop()
  } catch (error) {
    if (error instanceof Error && error.message === 'kill refused') {
      // Injected child.kill throw already asserted; native kill is restored in that test.
      return
    }
    throw error
  }
}

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
