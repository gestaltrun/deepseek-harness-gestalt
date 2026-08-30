import { spawnSync } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PortHandoffCollision, quiesceRecordedProcesses, runLogged, settleCleanupSteps, withDistinctPortHandoff,
} from '../../scripts/e2e-electron-runner-support.mjs'

const roots: string[] = []
const cleanupPids = new Set<number>()

afterEach(async () => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  cleanupPids.clear()
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-runner-test-'))
  roots.push(root)
  return root
}

function discard(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback() } })
}

async function waitForPids(file: string): Promise<{ parent: number; child: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as { parent: number; child: number }
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    }
  }
  throw new Error('child process tree did not publish its pids')
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Desktop Electron runner ownership', () => {
  it('returns only after stdout and stderr are fully persisted', async () => {
    const root = await temporaryRoot()
    const logFile = join(root, 'child.log')
    const child = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', `setTimeout(() => { process.stdout.write('late stdout'); process.stderr.write('late stderr') }, 250)`], { stdio: ['ignore', 'inherit', 'inherit'] }).unref()",
    ].join(';')
    const code = await runLogged(process.execPath, ['-e', child], {
      cwd: root,
      env: process.env,
      logFile,
      stdout: discard(),
      stderr: discard(),
    })

    expect(code).toBe(0)
    const logged = await readFile(logFile, 'utf8')
    expect(logged).toContain('late stdout')
    expect(logged).toContain('late stderr')
  })

  it('settles every cleanup step and retains every independent failure', async () => {
    const calls: string[] = []
    const settled = await settleCleanupSteps([
      { name: 'process tree', run: () => { calls.push('process tree'); throw new Error('tree survived') } },
      { name: 'runtime root', run: () => { calls.push('runtime root') } },
      { name: 'ports', run: async () => { calls.push('ports'); throw new Error('port open') } },
    ])

    expect(calls).toEqual(['process tree', 'runtime root', 'ports'])
    expect(settled.outcomes.map(outcome => ({ name: outcome.name, ok: outcome.ok }))).toEqual([
      { name: 'process tree', ok: false },
      { name: 'runtime root', ok: true },
      { name: 'ports', ok: false },
    ])
    expect(settled.errors.map(error => error.message)).toEqual(['tree survived', 'port open'])
  })

  it('aborts the owned child process tree and waits for every descendant to exit', async () => {
    const root = await temporaryRoot()
    const pidsFile = join(root, 'pids.json')
    const controller = new AbortController()
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 3000)`], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: child.pid }))`,
      "process.on('SIGTERM', () => {})",
      'setTimeout(() => process.exit(0), 1000)',
    ].join(';')
    const running = runLogged(process.execPath, ['-e', script], {
      cwd: root,
      env: process.env,
      logFile: join(root, 'tree.log'),
      stdout: discard(),
      stderr: discard(),
      signal: controller.signal,
      terminateGraceMs: 50,
    })
    const pids = await waitForPids(pidsFile)
    cleanupPids.add(pids.parent)
    cleanupPids.add(pids.child)
    controller.abort(new Error('test abort'))

    await expect(running).rejects.toThrow(/test abort/)
    expect(processExists(pids.parent)).toBe(false)
    expect(processExists(pids.child)).toBe(false)
    cleanupPids.delete(pids.parent)
    cleanupPids.delete(pids.child)
  })

  it.skipIf(process.platform === 'win32')('terminates the owned tree when the serial log writer fails', async () => {
    const root = await temporaryRoot()
    const fifo = join(root, 'runner.log')
    const pidsFile = join(root, 'writer-pid.json')
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
    if (created.status !== 0) throw new Error(`mkfifo failed: ${created.stderr}`)
    const reader = await open(fifo, 'r+')
    const script = [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: process.pid }))`,
      "setInterval(() => process.stdout.write('log chunk'.repeat(1024)), 5)",
    ].join(';')
    const running = runLogged(process.execPath, ['-e', script], {
      cwd: root,
      env: process.env,
      logFile: fifo,
      stdout: discard(),
      stderr: discard(),
      terminateGraceMs: 50,
    })
    const pids = await waitForPids(pidsFile)
    cleanupPids.add(pids.parent)
    await reader.close()

    await expect(running).rejects.toThrow()
    expect(processExists(pids.parent)).toBe(false)
    cleanupPids.delete(pids.parent)
  })

  it('rejects missing process ownership evidence instead of treating it as clean', async () => {
    const root = await temporaryRoot()
    await expect(quiesceRecordedProcesses(join(root, 'missing.json'), ['electronPid', 'hostPid']))
      .rejects.toThrow(/owned process evidence or quiescence failed/)
  })

  it('hands off distinct reserved ports and retries a verified collision with fresh ports', async () => {
    const seen: Array<{ fakePort: number; cdpPort: number }> = []
    const value = await withDistinctPortHandoff(async (ports, attempt) => {
      seen.push(ports)
      expect(ports.fakePort).not.toBe(ports.cdpPort)
      if (attempt === 1) {
        const collider = createServer()
        await new Promise<void>((resolve, reject) => {
          collider.once('error', reject)
          collider.listen(ports.fakePort, '127.0.0.1', resolve)
        })
        await new Promise<void>((resolve, reject) => {
          collider.close((error) => { if (error === undefined) resolve(); else reject(error) })
        })
        throw new PortHandoffCollision('simulated handoff collision')
      }
      return 'owned'
    })

    expect(value).toBe('owned')
    expect(seen).toHaveLength(2)
    expect(seen[1]?.fakePort).not.toBe(seen[0]?.fakePort)
    expect(seen[1]?.cdpPort).not.toBe(seen[0]?.cdpPort)
  })
})
