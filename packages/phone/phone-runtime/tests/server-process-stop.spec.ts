import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn<(command: string, argv: string[], options?: {
    timeout?: number
    killSignal?: NodeJS.Signals
  }) => {
    status: number | null
    error?: Error
    stderr?: string
  }>(),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }))

import { MobilecliServerProcess, TERM_ESCAPE_MS } from '../src/server-process.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MobilecliServerProcess stop policy', () => {
  it('retains a normal child exit without sending a stop signal', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const kill = vi.fn()
    const child = Object.assign(events, { pid: 12_345, stderr, kill }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)

    const runtimeProcess = new MobilecliServerProcess({ executablePath: '/mobilecli', port: 12_000 })
    events.emit('close', 0, null)
    await expect(runtimeProcess.exit).resolves.toEqual({ code: 0 })
    await runtimeProcess.stop()

    expect(kill).not.toHaveBeenCalled()
    expect(runtimeProcess.alive).toBe(false)
  })

  it('escalates a child that remains alive after SIGTERM', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    let closed = false
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') queueMicrotask(() => {
        closed = true
        events.emit('close', null, signal)
      })
      return true
    })
    const child = Object.assign(events, { pid: 12_345, stderr, kill }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: '/mobilecli', port: 12_000 },
      {
        platform: 'darwin',
        probeGroup: () => {
          if (closed) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        },
        signalGroup: (_pid, signal) => { kill(signal) },
      },
    )
    await runtimeProcess.stop()

    expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    await expect(runtimeProcess.exit).resolves.toEqual({ code: null, signal: 'SIGKILL' })
    expect(runtimeProcess.alive).toBe(false)
  }, TERM_ESCAPE_MS + 5_000)

  it('uses one immediate bounded Windows forced tree termination', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 23_456, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockImplementation(() => {
      queueMicrotask(() => { events.emit('close', null, 'SIGKILL') })
      return { status: 0 }
    })

    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )
    await runtimeProcess.stop()

    expect(spawnSyncMock.mock.calls.map(([, argv]) => argv)).toEqual([
      ['/PID', '23456', '/T', '/F'],
    ])
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({
      timeout: TERM_ESCAPE_MS,
      killSignal: 'SIGKILL',
    })
    expect(runtimeProcess.alive).toBe(false)
  }, TERM_ESCAPE_MS + 5_000)

  it('falls back to the direct child when a POSIX group vanishes during signalling', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    let closed = false
    const kill = vi.fn((signal: NodeJS.Signals) => {
      closed = true
      queueMicrotask(() => { events.emit('close', null, signal) })
      return true
    })
    const child = Object.assign(events, { pid: 34_567, stderr, kill }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)

    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: '/mobilecli', port: 12_000 },
      {
        platform: 'darwin',
        probeGroup: () => {
          if (closed) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        },
        signalGroup: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
      },
    )
    await runtimeProcess.stop()

    expect(kill).toHaveBeenCalledWith('SIGTERM')
    expect(runtimeProcess.alive).toBe(false)
  })

  it('distinguishes permission-denied and unknown POSIX group probes', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 45_678, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    let code = 'EPERM'
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: '/mobilecli', port: 12_000 },
      {
        platform: 'darwin',
        probeGroup: () => { throw Object.assign(new Error('probe failed'), { code }) },
      },
    )

    expect(runtimeProcess.alive).toBe(true)
    code = 'EIO'
    expect(runtimeProcess.alive).toBe(true)
    events.emit('close', 0, null)
    expect(runtimeProcess.alive).toBe(false)
    await runtimeProcess.stop()
  })

  it('surfaces an unexpected POSIX group signal failure', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    let closed = false
    const child = Object.assign(events, { pid: 56_789, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: '/mobilecli', port: 12_000 },
      {
        platform: 'darwin',
        probeGroup: () => {
          if (closed) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        },
        signalGroup: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
      },
    )

    await expect(runtimeProcess.stop()).rejects.toThrow('mobilecli process-tree stop failed')
    closed = true
    events.emit('close', 0, null)
    await runtimeProcess.stop()
  })

  it('bounds and reports repeated Windows taskkill refusal', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 67_890, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockReturnValue({ status: 5, stderr: 'Access is denied.' })
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )

    const stopping = runtimeProcess.stop()
    const refusal = expect(stopping).rejects.toThrow('mobilecli process-tree stop failed')
    await vi.advanceTimersByTimeAsync(TERM_ESCAPE_MS + 100)
    await refusal
    expect(spawnSyncMock).toHaveBeenCalledOnce()
    expect(MobilecliServerProcess.diagnostics.at(-1)).toContain('Access is denied')
    expect(stderr.destroyed).toBe(false)
  })

  it('does not treat an exited Windows launcher as tree quiescence when taskkill cannot confirm it', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 78_901, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockReturnValue({ status: 128, stderr: 'The process was not found.' })
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )
    events.emit('close', 1, null)

    await expect(runtimeProcess.stop()).rejects.toThrow('exited before its Windows process tree could be stopped safely')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('reports a timed-out Windows taskkill without reusing the pid', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 89_012, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockImplementationOnce(() => {
      queueMicrotask(() => { events.emit('close', null, 'SIGKILL') })
      return {
        status: null,
        error: Object.assign(new Error('taskkill timed out'), { code: 'ETIMEDOUT' }),
      }
    })
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )

    await expect(runtimeProcess.stop()).rejects.toThrow('taskkill timed out')
    expect(MobilecliServerProcess.diagnostics.join('\n')).toContain('taskkill timed out')
    expect(spawnSyncMock).toHaveBeenCalledOnce()
  })

  it('reports a nonzero Windows forced-termination status without stderr', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 90_123, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    spawnSyncMock.mockImplementationOnce(() => {
      queueMicrotask(() => { events.emit('close', null, 'SIGKILL') })
      return { status: 1, stderr: '' }
    })
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )

    await expect(runtimeProcess.stop()).rejects.toThrow('status 1')
    expect(MobilecliServerProcess.diagnostics.join('\n')).toContain('status 1')
  })

  it('contains a non-Error Windows termination failure without a second taskkill', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 90_124, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      {
        platform: 'win32',
        taskkill: () => {
          queueMicrotask(() => { events.emit('close', null, 'SIGKILL') })
          throw 'forced termination refused'
        },
      },
    )

    await expect(runtimeProcess.stop()).rejects.toBe('forced termination refused')
    expect(MobilecliServerProcess.diagnostics.join('\n')).toContain('forced termination refused')
  })

  it('treats a failed Windows spawn without a pid as already quiescent', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: undefined, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )
    events.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))

    await runtimeProcess.stop()
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('bounds a Windows launcher that never publishes a pid or close event', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: undefined, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: 'mobilecli.exe', port: 12_000 },
      { platform: 'win32' },
    )

    const stopping = runtimeProcess.stop()
    const refusal = expect(stopping).rejects.toThrow('without-pid survived forced termination')
    await vi.advanceTimersByTimeAsync(TERM_ESCAPE_MS + 100)
    await refusal
  })

  it('bounds a process tree whose launcher never published a pid or close event', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: undefined, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess({ executablePath: '/mobilecli', port: 12_000 })

    const stopping = runtimeProcess.stop()
    const refusal = expect(stopping).rejects.toThrow('without-pid survived SIGTERM and SIGKILL')
    await vi.advanceTimersByTimeAsync((TERM_ESCAPE_MS * 2) + 100)
    await refusal
  })

  it('waits a bounded interval for direct-child settlement after the POSIX group vanishes', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 91_234, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: '/mobilecli', port: 12_000 },
      { platform: 'darwin', probeGroup: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) } },
    )

    const stopping = runtimeProcess.stop()
    const refusal = expect(stopping).rejects.toThrow('exited without child settlement')
    await vi.advanceTimersByTimeAsync(TERM_ESCAPE_MS + 100)
    await refusal
  })

  it('accepts a late child settlement after the POSIX group vanishes', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: 92_345, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess(
      { executablePath: '/mobilecli', port: 12_000 },
      { platform: 'darwin', probeGroup: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) } },
    )
    setTimeout(() => { events.emit('close', 0, null) }, 10)

    await runtimeProcess.stop()
    await expect(runtimeProcess.exit).resolves.toEqual({ code: 0 })
  })

  it('contains teardown before a spawned child publishes its pid', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const child = Object.assign(events, { pid: undefined, stderr, kill: vi.fn() }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)
    const runtimeProcess = new MobilecliServerProcess({ executablePath: '/mobilecli', port: 12_000 })

    queueMicrotask(() => { events.emit('close', null, null) })
    await runtimeProcess.stop()

    expect(runtimeProcess.alive).toBe(false)
  })
})
