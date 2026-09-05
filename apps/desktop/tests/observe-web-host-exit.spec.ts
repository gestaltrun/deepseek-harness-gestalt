import { describe, expect, it } from 'vitest'
import { observeWebHostExit } from '../src/observe-web-host-exit.ts'
import type { WebHostExit } from '../src/spawn-web-host.ts'

function fakeExit(requestedStop: WebHostExit['requestedStop']['kind']): WebHostExit {
  return Object.freeze({
    pid: 1,
    code: 1,
    signal: null,
    requestedStop: Object.freeze({ kind: requestedStop }),
  })
}

describe('observeWebHostExit', () => {
  it('calls recovery when diagnostic log throws before onHostExit', async () => {
    const record = fakeExit('none')
    let recoveryCalled = false
    observeWebHostExit(
      { exited: Promise.resolve(record) },
      () => { throw new Error('appendFileSync EACCES') },
      () => { recoveryCalled = true },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(recoveryCalled).toBe(true)
  })

  it('contains a rejected recovery callback without emitting the error text', async () => {
    const record = fakeExit('stop')
    const sentinel = 'fixture-secret-abcdefgh'
    const seen: string[] = []
    const onWarning = (warning: Error): void => {
      seen.push(warning.message, warning.name)
      if ('code' in warning) seen.push(String(warning.code))
    }
    process.on('warning', onWarning)
    try {
      observeWebHostExit(
        { exited: Promise.resolve(record) },
        () => undefined,
        async () => { throw new Error(`https://user:${sentinel}@example.test`) },
      )
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(seen.join('\n')).not.toContain(sentinel)
      expect(seen.join('\n')).not.toContain('https://')
      expect(seen).toContain('web host exit recovery failed')
      expect(seen).toContain('DSH_WEB_HOST_EXIT_RECOVERY_FAILED')
    } finally {
      process.off('warning', onWarning)
    }
  })

  it('contains a synchronous onExit throw without an unhandled rejection', async () => {
    const record = fakeExit('none')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      observeWebHostExit(
        { exited: Promise.resolve(record) },
        () => undefined,
        () => { throw new Error('onHostExit threw') },
      )
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
