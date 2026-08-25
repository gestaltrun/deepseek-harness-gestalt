import { describe, expect, it, vi } from 'vitest'
import { desktopRelayProxyAgent, desktopSystemFetch } from '../src/system-network.ts'

describe('Desktop system network', () => {
  it('forwards Platform HTTP through the Electron session fetch owner', async () => {
    const response = new Response('{}', { status: 200 })
    const electronFetch = vi.fn(async () => response)
    const fetch = desktopSystemFetch(electronFetch)

    await expect(fetch('https://www.gestaltrun.com/healthz', { method: 'GET' })).resolves.toBe(response)
    expect(electronFetch).toHaveBeenCalledWith('https://www.gestaltrun.com/healthz', { method: 'GET' })
  })

  it('maps Electron HTTP proxy rules to CONNECT agents and preserves DIRECT', () => {
    expect(desktopRelayProxyAgent('PROXY 127.0.0.1:6152; DIRECT')).toBeDefined()
    expect(desktopRelayProxyAgent('HTTPS proxy.example:8443')).toBeDefined()
    expect(desktopRelayProxyAgent('DIRECT')).toBeUndefined()
    expect(() => desktopRelayProxyAgent('SOCKS5 proxy.example:1080; DIRECT')).toThrow('unsupported')
    expect(() => desktopRelayProxyAgent('PROXY missing-port')).toThrow('invalid')
  })
})
