/** The shared browser-trust fence: both HTTP representations and the config predicate. */

import { describe, expect, it } from 'vitest'
import { isBareAuthority, isLoopbackApiRequest, isTrustedApiRequest } from '../src/index.ts'

/** The same request facts carried by the Fetch representation (Fetch Request.headers). */
function fetchRequest(headers: Record<string, string>) {
  return { headers: new Headers(headers) }
}

describe('isTrustedApiRequest over the Fetch Headers representation', () => {
  it('reads the same trust judgment from Headers as from Node header records', () => {
    expect(isTrustedApiRequest(fetchRequest({ host: '127.0.0.1:3080' }), [])).toBe(true)
    expect(isTrustedApiRequest(fetchRequest({ host: '192.168.1.5:3080' }), ['192.168.1.5'])).toBe(true)
    expect(isTrustedApiRequest(fetchRequest({ host: '192.168.1.5:3080' }), [])).toBe(false)
    expect(isTrustedApiRequest(fetchRequest({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), [])).toBe(false)
    expect(isTrustedApiRequest(fetchRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    expect(isTrustedApiRequest(fetchRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), [])).toBe(true)
    expect(isTrustedApiRequest(fetchRequest({}), [])).toBe(false)
    expect(isTrustedApiRequest(fetchRequest({ host: 'bad host' }), [])).toBe(false)
  })

  it('never lets a repeated Node header value widen the Host judgment', () => {
    const repeated = { headers: { host: ['127.0.0.1:3080', '127.0.0.1:3080'] } }
    expect(isTrustedApiRequest(repeated, [])).toBe(false)
    expect(isLoopbackApiRequest(repeated)).toBe(false)
  })
})

describe('isLoopbackApiRequest over the Fetch Headers representation', () => {
  it('accepts loopback Hosts only', () => {
    expect(isLoopbackApiRequest(fetchRequest({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(isLoopbackApiRequest(fetchRequest({ host: 'localhost:3080' }))).toBe(true)
    expect(isLoopbackApiRequest(fetchRequest({ host: '192.168.1.5:3080' }))).toBe(false)
    expect(isLoopbackApiRequest(fetchRequest({}))).toBe(false)
    expect(isLoopbackApiRequest(fetchRequest({ host: 'bad host' }))).toBe(false)
  })
})

describe('isBareAuthority', () => {
  it('accepts bare canonical authorities', () => {
    for (const entry of ['harness.internal', 'harness.internal:3080', 'HARNESS.internal:80', '10.0.0.9', '[::1]:3080']) {
      expect(isBareAuthority(entry)).toBe(true)
    }
  })

  it('refuses every shape WHATWG parsing would rewrite, strip, or broaden', () => {
    for (const entry of [
      'harness.internal/path',
      'user@harness.internal',
      'harness.internal?x',
      'harness.internal#f',
      'bad entry',
      '',
      'harness.internal:3080 ',
      ' harness.internal',
      'harness.internal:',
      'harness.internal:0080',
      '0x7f.0.0.1',
      '[0:0:0:0:0:0:0:1]',
    ]) {
      expect(isBareAuthority(entry)).toBe(false)
    }
  })
})
