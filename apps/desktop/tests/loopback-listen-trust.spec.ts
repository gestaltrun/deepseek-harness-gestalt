import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createLoopbackListenFetch,
  isLoopbackListenUrl,
  openDesktopAuthorizationUrl,
} from '../src/loopback-listen-trust.ts'

const certDir = fileURLToPath(new URL('../../../examples/two-instance-relay/fixtures/', import.meta.url))

describe('loopback listen trust', () => {
  it('accepts only loopback HTTPS or WSS listen URLs', () => {
    expect(isLoopbackListenUrl('https://127.0.0.1:8443')).toBe(true)
    expect(isLoopbackListenUrl('wss://127.0.0.1:8443/v1/remote-access/relay')).toBe(true)
    expect(isLoopbackListenUrl('https://localhost:8443')).toBe(true)
    expect(isLoopbackListenUrl('https://[::1]:8443')).toBe(true)
    expect(isLoopbackListenUrl('https://www.gestaltrun.com')).toBe(false)
    expect(isLoopbackListenUrl('http://127.0.0.1:5174')).toBe(false)
  })

  it('fetches a bundled-certificate loopback listen and follows a 303', async () => {
    expect(createLoopbackListenFetch('https://www.gestaltrun.com')).toBeUndefined()
    const fetch = createLoopbackListenFetch('https://127.0.0.1:8443')
    if (fetch === undefined) throw new Error('expected loopback Fetch')
    const server = createServer({
      cert: readFileSync(`${certDir}localhost-cert.pem`),
      key: readFileSync(`${certDir}localhost-key.pem`),
    }, (req, res) => {
      if (req.url === '/empty') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.url === '/redirect') {
        res.writeHead(303, { location: '/ok' })
        res.end()
        return
      }
      if (req.url === '/complete') {
        res.writeHead(303, { location: '/hang' })
        res.end()
        return
      }
      if (req.url === '/hang') {
        return
      }
      if (req.url === '/missing') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const origin = `https://127.0.0.1:${String(address.port)}`
    try {
      await expect(globalThis.fetch(`${origin}/ok`)).rejects.toThrow()
      const ok = await fetch(`${origin}/ok`)
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true })
      const empty = await fetch(`${origin}/empty`)
      expect(empty.status).toBe(204)
      const redirected = await fetch(`${origin}/redirect`)
      expect(redirected.status).toBe(200)
      expect(await redirected.json()).toEqual({ ok: true })
      const posted = await fetch(`${origin}/ok`, { method: 'POST', body: '{}' })
      expect(posted.status).toBe(200)
      const postedRequest = await fetch(new Request(`${origin}/ok`, { method: 'POST', body: '{}' }))
      expect(postedRequest.status).toBe(200)
      const opened: string[] = []
      await openDesktopAuthorizationUrl(`${origin}/complete`, async (url) => { opened.push(url) })
      await openDesktopAuthorizationUrl('https://github.com/login', async (url) => { opened.push(url) })
      expect(opened).toEqual(['https://github.com/login'])
      await expect(openDesktopAuthorizationUrl(`${origin}/missing`, async () => {})).rejects.toThrow('loopback authorization')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})
