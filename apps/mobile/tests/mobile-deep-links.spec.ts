import { describe, expect, it, vi } from 'vitest'
import { bindMobilePairingDeepLinks } from '../src/mobile-deep-links.ts'

describe('Mobile pairing deep links', () => {
  it('delivers the launch URL and later application URLs through one ordered pairing path', async () => {
    let listener: ((event: { url: string }) => void) | undefined
    const complete = vi.fn(async (_link: string) => {})
    const binding = bindMobilePairingDeepLinks(complete, {
      app: {
        getLaunchUrl: async () => ({ url: 'https://www.gestaltrun.com/pair/launch' }),
        addListener: async (_name, callback) => {
          listener = callback
          return { remove: async () => {} }
        },
      },
    })
    binding.setReady(true)
    await vi.waitFor(() => { expect(complete).toHaveBeenCalledWith('https://www.gestaltrun.com/pair/launch') })
    listener?.({
      url: 'deepseek-gestalt://pair?link=https%3A%2F%2Fwww.gestaltrun.com%2Fpair%2Fforeground',
    })
    await vi.waitFor(() => { expect(complete).toHaveBeenLastCalledWith('https://www.gestaltrun.com/pair/foreground') })
    await binding.dispose()
    expect(complete.mock.calls.map(call => call[0])).toEqual([
      'https://www.gestaltrun.com/pair/launch',
      'https://www.gestaltrun.com/pair/foreground',
    ])
  })

  it('reports rejected links and removes its native listener', async () => {
    const remove = vi.fn(async () => {})
    const onError = vi.fn()
    const binding = bindMobilePairingDeepLinks(async () => { throw new Error('expired pairing link') }, {
      app: {
        getLaunchUrl: async () => ({ url: 'https://www.gestaltrun.com/pair/expired' }),
        addListener: async () => ({ remove }),
      },
      onError,
    })
    binding.setReady(true)
    await vi.waitFor(() => { expect(onError).toHaveBeenCalled() })
    await binding.dispose()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('queues a cold launch URL until pairing activation and deduplicates the native event copy', async () => {
    let listener: ((event: { url: string }) => void) | undefined
    const link = 'deepseek-gestalt://pair?link=https%3A%2F%2Fwww.gestaltrun.com%2Fpair%2Fcold'
    const complete = vi.fn(async () => {})
    const binding = bindMobilePairingDeepLinks(complete, {
      app: {
        getLaunchUrl: async () => ({ url: link }),
        addListener: async (_name, callback) => {
          listener = callback
          return { remove: async () => {} }
        },
      },
    })

    listener?.({ url: link })
    await Promise.resolve()
    expect(complete).not.toHaveBeenCalled()
    binding.setReady(true)
    await vi.waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
    expect(complete).toHaveBeenCalledWith('https://www.gestaltrun.com/pair/cold')
    await binding.dispose()
  })
})
