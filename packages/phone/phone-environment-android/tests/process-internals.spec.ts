import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}))

import { createNodeAndroidCommandRunner } from '../src/process.ts'

interface FakeChild extends EventEmitter {
  pid: number | undefined
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
  close(exitCode: number | null, signal: NodeJS.Signals | null): void
}

function fakeChild(pid: number | undefined = 42): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.close = (exitCode, signal) => {
    child.exitCode = exitCode
    child.signalCode = signal
    child.emit('close', exitCode, signal)
  }
  return child
}

afterEach(() => {
  spawnMock.mockReset()
  spawnSyncMock.mockReset()
  vi.restoreAllMocks()
})

describe('Android process adapter internals', () => {
  it('captures bounded output, input, and ordinary exit facts', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const runner = createNodeAndroidCommandRunner({ platform: 'win32' })
    const operation = runner.run('tool.exe', ['arg'], { env: {}, input: 'yes\n' })
    child.stdout.emit('data', Buffer.from(`discard${'x'.repeat(9_000)}`))
    child.stderr.emit('data', Buffer.from('warning'))
    child.close(0, null)
    const result = await operation
    expect(result).toMatchObject({
      exitCode: 0, signal: null, timedOut: false, callerAborted: false, stderr: 'warning',
    })
    expect(result.stdout).toHaveLength(8_192)
    expect(child.stdin.end).toHaveBeenCalledWith('yes\n')
  })

  it('propagates a child spawn error', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const operation = createNodeAndroidCommandRunner({ platform: 'win32' }).run('tool.exe', [], { env: {} })
    const failure = new Error('spawn failed')
    child.emit('error', failure)
    await expect(operation).rejects.toBe(failure)
  })

  it('records cancellation delivered after spawn and removes its listener after close', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const taskkill = vi.fn((_pid: number, force: boolean) => {
      child.close(null, force ? 'SIGKILL' : 'SIGTERM')
    })
    const operation = createNodeAndroidCommandRunner({ platform: 'win32', taskkill }).run(
      'tool.exe', [], { env: {}, signal: controller.signal },
    )
    controller.abort()
    await expect(operation).resolves.toMatchObject({ callerAborted: true, signal: 'SIGTERM' })
    controller.abort()
    expect(taskkill).toHaveBeenCalledOnce()
  })

  it('settles a command whose forced termination never produces close', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const operation = createNodeAndroidCommandRunner({
      platform: 'win32', taskkill: () => {}, stopGraceMs: 1,
    }).run('tool.exe', [], { env: {}, timeoutMs: 1 })
    await expect(operation).resolves.toMatchObject({
      timedOut: true,
      terminationError: 'Android process 42 did not exit after forced termination',
    })
  })

  it('joins an already-exited owned process', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const owned = createNodeAndroidCommandRunner({ platform: 'win32' }).spawn('emulator.exe', [], { env: {} })
    child.close(0, null)
    await owned.exit
    await expect(owned.stop()).resolves.toBeUndefined()
  })

  it('bounds a process without a pid and reports the fallback stop failure', async () => {
    const child = fakeChild()
    child.pid = undefined
    spawnMock.mockReturnValue(child)
    const owned = createNodeAndroidCommandRunner({ platform: 'win32', stopGraceMs: 1 }).spawn(
      'emulator.exe', [], { env: {} },
    )
    await expect(owned.stop()).rejects.toThrow('Android process undefined did not exit after forced termination')
    child.close(null, 'SIGKILL')
    await owned.exit
  })

  it('skips termination when the process exits between the two stop checks', async () => {
    const child = fakeChild()
    let reads = 0
    Object.defineProperty(child, 'exitCode', {
      configurable: true,
      get: () => {
        reads += 1
        return reads === 1 ? null : 0
      },
      set: () => {},
    })
    child.signalCode = null
    spawnMock.mockReturnValue(child)
    const owned = createNodeAndroidCommandRunner({ platform: 'win32', stopGraceMs: 1 }).spawn(
      'emulator.exe', [], { env: {} },
    )
    queueMicrotask(() => { child.emit('close', 0, null) })
    await expect(owned.stop()).resolves.toBeUndefined()
  })

  it('does not schedule a second graceful escape for concurrent cancellation and timeout', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const operation = createNodeAndroidCommandRunner({
      platform: 'win32', taskkill: () => {}, stopGraceMs: 1,
    }).run('tool.exe', [], { env: {}, signal: controller.signal, timeoutMs: 1 })
    controller.abort()
    await expect(operation).resolves.toMatchObject({ callerAborted: true, timedOut: true })
  })

  it('normalizes a non-Error taskkill failure onto the settled process', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const owned = createNodeAndroidCommandRunner({
      platform: 'win32', stopGraceMs: 1,
      taskkill: () => {
        queueMicrotask(() => { child.close(null, 'SIGTERM') })
        throw 'taskkill string failure'
      },
    }).spawn('emulator.exe', [], { env: {} })
    await expect(owned.stop()).rejects.toThrow('taskkill string failure')
    await expect(owned.exit).resolves.toMatchObject({ terminationError: 'taskkill string failure' })
  })

  it.each([
    [{ error: new Error('taskkill spawn failed'), status: null, signal: null }, 'taskkill spawn failed'],
    [{ status: 1, signal: null }, 'taskkill exited with 1'],
    [{ status: 1, signal: 'SIGKILL' }, 'taskkill exited with 1 by SIGKILL'],
  ])('surfaces default taskkill failure %#', async (result, message) => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockImplementation(() => {
      queueMicrotask(() => { child.close(null, 'SIGTERM') })
      return result
    })
    const owned = createNodeAndroidCommandRunner({ platform: 'win32', stopGraceMs: 1 }).spawn(
      'emulator.exe', [], { env: {} },
    )
    await expect(owned.stop()).rejects.toThrow(message)
    await owned.exit
  })

  it.each([
    ['ESRCH', undefined],
    ['EACCES', 'kill refused'],
  ] as const)('handles POSIX process-group kill result %s', async (code, expectedFailure) => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error(expectedFailure ?? 'gone') as NodeJS.ErrnoException
      error.code = code
      queueMicrotask(() => { child.close(null, 'SIGTERM') })
      throw error
    })
    const owned = createNodeAndroidCommandRunner({ platform: 'linux', stopGraceMs: 1 }).spawn(
      '/sdk/emulator', [], { env: {} },
    )
    if (expectedFailure === undefined) await expect(owned.stop()).resolves.toBeUndefined()
    else await expect(owned.stop()).rejects.toThrow(expectedFailure)
    await owned.exit
  })

  it('stops a POSIX process group without a termination error', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => { child.close(null, 'SIGTERM') })
      return true
    })
    const owned = createNodeAndroidCommandRunner({ platform: 'linux', stopGraceMs: 1 }).spawn(
      '/sdk/emulator', [], { env: {} },
    )
    await expect(owned.stop()).resolves.toBeUndefined()
    await owned.exit
  })

  it('normalizes a non-Error POSIX kill failure', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => { child.close(null, 'SIGTERM') })
      throw 'kill string failure'
    })
    const owned = createNodeAndroidCommandRunner({ platform: 'linux', stopGraceMs: 1 }).spawn(
      '/sdk/emulator', [], { env: {} },
    )
    await expect(owned.stop()).rejects.toThrow('kill string failure')
    await owned.exit
  })

  it('accepts a successful default taskkill result', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockImplementation(() => {
      queueMicrotask(() => { child.close(null, 'SIGTERM') })
      return { status: 0, signal: null }
    })
    const owned = createNodeAndroidCommandRunner({ platform: 'win32', stopGraceMs: 1 }).spawn(
      'emulator.exe', [], { env: {} },
    )
    await expect(owned.stop()).resolves.toBeUndefined()
    await owned.exit
  })
})
