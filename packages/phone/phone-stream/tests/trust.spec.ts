import { describe, expect, it } from 'vitest'
import { isLoopbackApiRequest, isLoopbackHostname, isTrustedApiRequest } from '../src/trust.ts'

function request(headers: Record<string, string>) {
  return { headers }
}

describe('phone stream trust fence', () => {
  it('accepts loopback Hosts and declared authorities', () => {
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080' }), [])).toBe(true)
    expect(isLoopbackApiRequest(request({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedApiRequest(request({ host: '192.168.1.5:3080' }), ['192.168.1.5'])).toBe(true)
    expect(isLoopbackApiRequest(request({ host: '192.168.1.5:3080' }))).toBe(false)
  })

  it('refuses a missing Host, a non-loopback Host without trust, and cross-site markers', () => {
    expect(isTrustedApiRequest(request({}), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: 'evil.example' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), [])).toBe(false)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'bad host' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'not a url' }), [])).toBe(false)
    expect(isLoopbackApiRequest(request({}))).toBe(false)
    expect(isLoopbackApiRequest(request({ host: 'bad host' }))).toBe(false)
    expect(isTrustedApiRequest(request({ host: 'harness.internal:3080' }), ['harness.internal:3080'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'harness.internal:3080' }), ['harness.internal'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'harness.internal:3080' }), [':::'])).toBe(false)
  })
})
