import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

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

    const process = new MobilecliServerProcess({ executablePath: '/mobilecli', port: 12_000 })
    events.emit('close', 0, null)
    await expect(process.exit).resolves.toEqual({ code: 0 })
    await process.stop()

    expect(kill).not.toHaveBeenCalled()
    expect(process.alive).toBe(false)
  })

  it('escalates a child that remains alive after SIGTERM', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') queueMicrotask(() => events.emit('close', null, signal))
      return true
    })
    const child = Object.assign(events, { pid: 12_345, stderr, kill }) as unknown as ChildProcess
    spawnMock.mockReturnValue(child)

    const process = new MobilecliServerProcess({ executablePath: '/mobilecli', port: 12_000 })
    const stopped = process.stop()
    await vi.advanceTimersByTimeAsync(TERM_ESCAPE_MS)
    await stopped

    expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    await expect(process.exit).resolves.toEqual({ code: null, signal: 'SIGKILL' })
    expect(process.alive).toBe(false)
  })
})
