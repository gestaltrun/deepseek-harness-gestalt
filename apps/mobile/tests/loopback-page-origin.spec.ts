import { describe, expect, it, vi } from 'vitest'
import {
  createLoopbackPageFetch,
  rewriteLoopbackPlatformUrl,
  rewriteLoopbackRelayUrl,
} from '../src/loopback-page-origin.ts'

describe('loopback page origin rewrite', () => {
  const page = 'http://127.0.0.1:5174'
  const platform = 'https://127.0.0.1:8443'

  it('rewrites selected HTTPS loopback Platform URLs onto the HTTP page origin', () => {
    expect(rewriteLoopbackPlatformUrl(
      'https://127.0.0.1:8443/v1/account/login-attempts', page, platform,
    )).toBe('http://127.0.0.1:5174/v1/account/login-attempts')
    expect(rewriteLoopbackRelayUrl(
      'wss://127.0.0.1:8443/v1/remote-access/relay', page, platform,
    )).toBe('ws://127.0.0.1:5174/v1/remote-access/relay')
  })

  it('leaves pairing-link hosts, production origins, and HTTPS pages unchanged', () => {
    expect(rewriteLoopbackPlatformUrl(
      'https://github.com/login/oauth/authorize', page, platform,
    )).toBe('https://github.com/login/oauth/authorize')
    expect(rewriteLoopbackPlatformUrl(
      'https://127.0.0.1:8443/v1/account/login-attempts',
      'https://127.0.0.1:8443',
      platform,
    )).toBe('https://127.0.0.1:8443/v1/account/login-attempts')
    expect(rewriteLoopbackPlatformUrl(
      'https://dev.example/v1/account/login-attempts',
      'http://127.0.0.1:5174',
      'https://dev.example',
    )).toBe('https://dev.example/v1/account/login-attempts')
    expect(rewriteLoopbackRelayUrl(
      'wss://relay.example/v1/remote-access/relay', page, platform,
    )).toBe('wss://relay.example/v1/remote-access/relay')
  })

  it('rewrites Fetch Request and string inputs through the bound global', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return new Response('{}', { status: 200 })
    }))
    const fetch = createLoopbackPageFetch(page, platform)
    await fetch('https://127.0.0.1:8443/v1/account/login-attempts')
    await fetch(new Request('https://127.0.0.1:8443/v1/account/login-poll', { method: 'POST' }))
    await fetch('https://github.com/login')
    expect(calls).toEqual([
      'http://127.0.0.1:5174/v1/account/login-attempts',
      'http://127.0.0.1:5174/v1/account/login-poll',
      'https://github.com/login',
    ])
    vi.unstubAllGlobals()
  })
})
