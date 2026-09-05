import { EventEmitter, getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ServerResponseCaptureSink } from '../src/server-response-capture-sink.ts'

class FakeResponse extends EventEmitter {
  headersSent = false
  writableFinished = false
  readonly writeHead = vi.fn(() => { this.headersSent = true })
  readonly write = vi.fn(() => false)
  readonly end = vi.fn(() => { this.writableFinished = true })
  readonly destroy = vi.fn()
}

function expectPendingListeners(response: FakeResponse, signal: AbortSignal): void {
  expect(response.listenerCount('drain')).toBe(1)
  expect(response.listenerCount('close')).toBe(1)
  expect(response.listenerCount('error')).toBe(1)
  expect(getEventListeners(signal, 'abort')).toHaveLength(1)
}
function expectNoListeners(response: FakeResponse, signal: AbortSignal): void {
  expect(response.listenerCount('drain')).toBe(0)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
}

describe('ServerResponseCaptureSink', () => {
  it('resolves drain and removes every listener', async () => {
    const response = new FakeResponse(); const signal = new AbortController()
    const writing = new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), signal.signal)
    expectPendingListeners(response, signal.signal)
    response.emit('drain'); await writing
    expectNoListeners(response, signal.signal)
  })

  it('resolves expected abort and removes every listener', async () => {
    const response = new FakeResponse(); const signal = new AbortController()
    const writing = new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), signal.signal)
    expectPendingListeners(response, signal.signal)
    const reason = new Error('stop'); signal.abort(reason); await expect(writing).rejects.toBe(reason)
    expectNoListeners(response, signal.signal)
  })

  it('rejects response close and removes every listener', async () => {
    const response = new FakeResponse(); const signal = new AbortController()
    const writing = new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), signal.signal)
    expectPendingListeners(response, signal.signal)
    response.emit('close')
    await expect(writing).rejects.toThrow('capture response closed before drain')
    expectNoListeners(response, signal.signal)
  })

  it('rejects the exact response error and removes every listener', async () => {
    const response = new FakeResponse(); const signal = new AbortController(); const error = new Error('failed')
    const writing = new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), signal.signal)
    expectPendingListeners(response, signal.signal)
    response.emit('error', error)
    await expect(writing).rejects.toBe(error)
    expectNoListeners(response, signal.signal)
  })

  it('installs no listeners for a pre-aborted signal', async () => {
    const response = new FakeResponse(); const signal = new AbortController(); const reason = new Error('stop'); signal.abort(reason)
    await expect(new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), signal.signal)).rejects.toBe(reason)
    expectNoListeners(response, signal.signal)
  })


  it('contains an abort fired synchronously during listener registration', async () => {
    const response = new FakeResponse(); const controller = new AbortController(); const reason = new Error('stop')
    const original = response.once.bind(response)
    response.once = ((event: string, listener: (...args: unknown[]) => void) => {
      const result = original(event, listener)
      if (event === 'error') controller.abort(reason)
      return result
    }) as typeof response.once
    await expect(new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), controller.signal)).rejects.toBe(reason)
    expectNoListeners(response, controller.signal)
  })

  it('installs no listeners when response accepts the write', async () => {
    const response = new FakeResponse(); response.write.mockReturnValueOnce(true)
    const signal = new AbortController()
    await new ServerResponseCaptureSink(response as never, false).write(Uint8Array.of(1), signal.signal)
    expectNoListeners(response, signal.signal)
  })

  it('ends normally, maps pre-header failure, and destroys post-header failure or abort', () => {
    const normal = new FakeResponse(); new ServerResponseCaptureSink(normal as never, false).end()
    expect(normal.end).toHaveBeenCalledOnce(); expect(normal.destroy).not.toHaveBeenCalled()
    const early = new FakeResponse(); new ServerResponseCaptureSink(early as never, false).fail(new Error('failed'))
    expect(early.writeHead).toHaveBeenCalled(); expect(early.destroy).not.toHaveBeenCalled()
    const late = new FakeResponse(); late.headersSent = true; const lateError = new Error('failed'); new ServerResponseCaptureSink(late as never, false).fail(lateError)
    expect(late.destroy).toHaveBeenCalledWith(lateError)
    const aborted = new FakeResponse(); new ServerResponseCaptureSink(aborted as never, false).abort()
    expect(aborted.destroy).toHaveBeenCalledWith(); expect(aborted.writeHead).not.toHaveBeenCalled()
  })
})
