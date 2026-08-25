import { describe, expect, it, vi } from 'vitest'
import { desktopRelayProxyCandidates, desktopSystemFetch } from '../src/system-network.ts'

describe('Desktop system network', () => {
  it('forwards Platform HTTP through the Electron session fetch owner', async () => {
    const response = new Response('{}', { status: 200 })
    const electronFetch = vi.fn(async () => response)
    const fetch = desktopSystemFetch(electronFetch)

    await expect(fetch('https://www.gestaltrun.com/healthz', { method: 'GET' })).resolves.toBe(response)
    expect(electronFetch).toHaveBeenCalledWith('https://www.gestaltrun.com/healthz', { method: 'GET' })
  })

  it('preserves Electron proxy fallback order including DIRECT', () => {
    const candidates = desktopRelayProxyCandidates(
      'PROXY first.example:6152; HTTPS second.example:8443; DIRECT',
    )
    expect(candidates.map(candidate => candidate.directive)).toEqual(['PROXY', 'HTTPS', 'DIRECT'])
    expect(candidates[0]?.agent).toBeDefined()
    expect(candidates[1]?.agent).toBeDefined()
    expect(candidates[2]?.agent).toBeUndefined()
    expect(desktopRelayProxyCandidates('')).toEqual([{ directive: 'DIRECT' }])
    expect(() => desktopRelayProxyCandidates('SOCKS5 proxy.example:1080; DIRECT')).toThrow('unsupported')
    expect(() => desktopRelayProxyCandidates('PROXY missing-port')).toThrow('invalid')
  })
})
