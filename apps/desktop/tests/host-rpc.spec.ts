import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { createDesktopHostRpc } from '../src/host-rpc.ts'

const closeServers: Array<() => Promise<void>> = []

afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())) })

describe('Desktop Host RPC', () => {
  it('rejects response bounds outside the Companion application-message ceiling', () => {
    expect(() => createDesktopHostRpc('http://127.0.0.1', { responseMaxBytes: 0 }))
      .toThrow(/positive safe integer within the Companion message ceiling/)
    expect(() => createDesktopHostRpc('http://127.0.0.1', {
      responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes + 1,
    })).toThrow(/positive safe integer within the Companion message ceiling/)
    expect(() => createDesktopHostRpc('http://127.0.0.1', {
      responseMaxBytes: 1, attachmentTimeoutMs: 0,
    })).toThrow('attachmentTimeoutMs must be a positive safe integer')
  })

  it('preserves success, HTTP 400, wire failure, business refusal, and timeout as typed results', async () => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          rpcId: string
          payload: { query: string }
        }
        switch (body.payload.query) {
          case 'http-400':
            response.writeHead(400).end('body is not JSON')
            return
          case 'wire-invalid':
            response.end('{not json')
            return
          case 'business':
            response.end(JSON.stringify({
              type: 'server-response',
              rpcId: body.rpcId,
              result: { ok: false, error: { code: 'bad-request', message: 'invalid search query', details: {} } },
            }))
            return
          case 'timeout':
            return
          case 'slow-chunks':
            response.write('{"type":"server-response","rpcId":' + JSON.stringify(body.rpcId) + ',"result":')
            setTimeout(() => { response.write('{"ok":true,') }, 35)
            setTimeout(() => { response.end('"value":{}}}') }, 70)
            return
          default:
            response.end(JSON.stringify({
              type: 'server-response',
              rpcId: body.rpcId,
              result: { ok: true, value: { items: [], hasMore: false } },
            }))
        }
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    closeServers.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const rpc = createDesktopHostRpc(`http://127.0.0.1:${String(address.port)}`, {
      timeoutMs: 25,
      responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    })

    await expect(rpc.call('session.search', { query: 'ok' })).resolves.toMatchObject({
      ok: true,
      value: { items: [], hasMore: false },
    })
    await expect(rpc.call('session.search', { query: 'http-400' })).resolves.toEqual({
      ok: false,
      failure: { kind: 'http', code: 'HOST_HTTP_STATUS', message: 'Desktop Host returned HTTP 400', status: 400 },
    })
    await expect(rpc.call('session.search', { query: 'wire-invalid' })).resolves.toEqual({
      ok: false,
      failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response was not valid RPC JSON' },
    })
    await expect(rpc.call('session.search', { query: 'business' })).resolves.toEqual({
      ok: false,
      failure: { kind: 'business', code: 'bad-request', message: 'invalid search query' },
    })
    await expect(rpc.call('session.search', { query: 'timeout' })).resolves.toEqual({
      ok: false,
      failure: { kind: 'timeout', code: 'HOST_TIMEOUT', message: 'Desktop Host request timed out' },
    })
    await expect(rpc.call('session.admitAttachment', { query: 'slow-chunks' }, { timeoutMs: 100 }))
      .resolves.toMatchObject({ ok: true, value: {} })
    const deadlineRpc = createDesktopHostRpc(`http://127.0.0.1:${String(address.port)}`, {
      timeoutMs: 50,
      responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    })
    await expect(deadlineRpc.call('session.search', { query: 'slow-chunks' })).resolves.toEqual({
      ok: false,
      failure: { kind: 'timeout', code: 'HOST_TIMEOUT', message: 'Desktop Host request timed out' },
    })
  })

  it('accepts the exact response byte limit and rejects overflow and a fast cumulative flood', async () => {
    const padding = 'x'.repeat(1_024)
    const responseBytes = Buffer.byteLength(successResponse('0'.repeat(36), padding))
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          rpcId: string
          payload: { query: string }
        }
        if (body.payload.query === 'fast-flood') {
          response.on('error', () => {})
          for (let index = 0; index < 32; index += 1) response.write(Buffer.alloc(256, 120))
          response.end()
          return
        }
        response.end(successResponse(body.rpcId, padding))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    closeServers.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const origin = `http://127.0.0.1:${String(address.port)}`
    const exact = createDesktopHostRpc(origin, { timeoutMs: 1_000, responseMaxBytes: responseBytes })
    const overflow = createDesktopHostRpc(origin, { timeoutMs: 1_000, responseMaxBytes: responseBytes - 1 })
    const flood = createDesktopHostRpc(origin, { timeoutMs: 1_000, responseMaxBytes: 1_024 })
    const attachment = createDesktopHostRpc(origin, {
      timeoutMs: 1, attachmentTimeoutMs: 1_000, responseMaxBytes: 1,
    })

    await expect(exact.call('session.search', { query: 'exact' })).resolves.toMatchObject({
      ok: true,
      value: { padding },
    })
    const limitFailure = {
      ok: false,
      failure: {
        kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response exceeded its byte limit',
      },
    } as const
    await expect(overflow.call('session.search', { query: 'overflow' })).resolves.toEqual(limitFailure)
    await expect(flood.call('session.search', { query: 'fast-flood' })).resolves.toEqual(limitFailure)
    await expect(attachment.call('session.attachment', { query: 'attachment' })).resolves.toMatchObject({
      ok: true, value: { padding },
    })
  })

  it('preserves non-2xx status before an oversized or never-ending response body', async () => {
    const closedResponses = new Set<string>()
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          payload: { query: string }
        }
        const query = body.payload.query
        response.on('close', () => { closedResponses.add(query) })
        response.on('error', () => {})
        response.writeHead(400)
        response.flushHeaders()
        if (query === 'oversized') {
          response.end(Buffer.alloc(2_048, 120))
          return
        }
        response.write('partial')
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    closeServers.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const rpc = createDesktopHostRpc(`http://127.0.0.1:${String(address.port)}`, {
      timeoutMs: 50,
      responseMaxBytes: 1_024,
    })
    const httpFailure = {
      ok: false,
      failure: { kind: 'http', code: 'HOST_HTTP_STATUS', message: 'Desktop Host returned HTTP 400', status: 400 },
    } as const

    await expect(Promise.all([
      rpc.call('session.search', { query: 'oversized' }),
      rpc.call('session.search', { query: 'never-ending' }),
    ])).resolves.toEqual([httpFailure, httpFailure])
    await expect.poll(() => closedResponses.size).toBe(2)
  })
})

function successResponse(rpcId: string, padding: string): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: true, value: { padding } },
  })
}
