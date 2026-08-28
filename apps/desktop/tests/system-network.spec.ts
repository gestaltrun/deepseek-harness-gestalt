import { describe, expect, it } from 'vitest'
import { desktopRelayProxyCandidates } from '../src/system-network.ts'

describe('Desktop system network', () => {
  it('preserves Electron proxy fallback order including DIRECT', () => {
    const candidates = desktopRelayProxyCandidates(
      'PROXY first.example:6152; HTTPS second.example:8443; DIRECT',
    )
    expect(candidates.map(candidate => candidate.directive)).toEqual(['PROXY', 'HTTPS', 'DIRECT'])
    expect(candidates[0]?.agent).toBeDefined()
    expect(candidates[0]?.proxyUrl).toBe('http://first.example:6152/')
    expect(candidates[1]?.agent).toBeDefined()
    expect(candidates[1]?.proxyUrl).toBe('https://second.example:8443/')
    expect(candidates[2]?.agent).toBeUndefined()
    expect(candidates[2]?.proxyUrl).toBeUndefined()
    expect(desktopRelayProxyCandidates('')).toEqual([{ directive: 'DIRECT' }])
    expect(() => desktopRelayProxyCandidates('SOCKS5 proxy.example:1080; DIRECT')).toThrow('unsupported')
    expect(() => desktopRelayProxyCandidates('PROXY missing-port')).toThrow('invalid')
    expect(() => desktopRelayProxyCandidates('PROXY user:secret@proxy.example:6152')).toThrow('must not contain credentials')
  })
})
