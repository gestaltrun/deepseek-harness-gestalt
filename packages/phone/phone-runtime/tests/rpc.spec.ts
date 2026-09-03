import http from 'node:http'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneDevicesError } from '../src/errors.ts'
import { MobilecliRpc, normalizeOperationError } from '../src/rpc.ts'

const httpServers: http.Server[] = []
const sockets = new Set<import('node:net').Socket>()

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(httpServers.map(current => new Promise<void>((resolveClose) => {
    current.close(() => {
      resolveClose()
    })
  })))
})

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const current = http.createServer((req, res) => {
    void Promise.resolve().then(() => {
      handler(req, res)
    })
  })
  httpServers.push(current)
  current.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return new Promise((resolveUrl) => {
    current.listen(0, '127.0.0.1', () => {
      const address = current.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolveUrl(`http://127.0.0.1:${String(port)}`)
    })
  })
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  return JSON.parse(raw) as unknown
}

/** Capture the PhoneDevicesError a call rejects with, failing when it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<PhoneDevicesError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PhoneDevicesError) return error
    throw error
  }
  throw new Error('expected the call to reject')
}

describe('MobilecliRpc.call', () => {
  it('posts JSON-RPC and returns the result field', async () => {
    let seenMethod: string | undefined
    let seenParams: unknown
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number; method?: string; params?: unknown }
        seenMethod = request.method
        seenParams = request.params
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { echoed: true } }))
      })
    })
    const answer = await new MobilecliRpc(url).call('devices.list', { includeOffline: true }, new AbortController().signal)
    expect(answer).toEqual({ echoed: true })
    expect(seenMethod).toBe('devices.list')
    expect(seenParams).toEqual({ includeOffline: true })
  })

  it('maps upstream -32010 onto PHONE_DEVICE_NOT_FOUND', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32010, message: 'nothing there' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).call('device.boot', {}, new AbortController().signal))
    expect(error.code).toBe('PHONE_DEVICE_NOT_FOUND')
    expect(error.message).toContain('nothing there')
  })

  it('wraps other upstream errors as PHONE_UPSTREAM with their code', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32050, message: 'slow device' } }))
      })
    })
    await expect(new MobilecliRpc(url).call('device.boot', {}, new AbortController().signal))
      .rejects.toThrow(expect.objectContaining({ code: 'PHONE_UPSTREAM' }))
  })

  it('fills defaults for upstream errors missing message and code', async () => {
    const url = await listen((req, res) => {
      void body(req).then(request => res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: (request as { id: number }).id,
        error: {},
      })))
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).call('device.boot', {}, new AbortController().signal))
    expect(error.code).toBe('PHONE_UPSTREAM')
    expect(error.message).toContain('upstream error')
  })

  it('rejects non-2xx with PHONE_PROTOCOL', async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).call('x', {}, new AbortController().signal))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('HTTP 500')
  })

  it('rejects unparseable and schema-less bodies', async () => {
    const garbage = await listen((_req, res) => res.end('not-json'))
    const garbageError = await rejectionOf(() => new MobilecliRpc(garbage).call('x', {}, new AbortController().signal))
    expect(garbageError.code).toBe('PHONE_PROTOCOL')
    expect(garbageError.message).toContain('valid JSON')
    const empty = await listen((_req, res) => res.end('{}'))
    const emptyError = await rejectionOf(() => new MobilecliRpc(empty).call('x', {}, new AbortController().signal))
    expect(emptyError.code).toBe('PHONE_PROTOCOL')
  })

  it('maps a response whose body is destroyed mid-flight onto PHONE_UNAVAILABLE', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"resu')
      setTimeout(() => {
        res.socket?.destroy()
      }, 20)
    })
    await expect(new MobilecliRpc(url).call('x', {}, new AbortController().signal))
      .rejects.toThrow(expect.objectContaining({ code: 'PHONE_UNAVAILABLE' }))
  })

  it('treats a capture with no content-type as a byte stream', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200)
      res.write(Buffer.from([0x00, 0x00, 0x00, 0x01]))
      res.end()
    })
    const capture = await new MobilecliRpc(url).stream('device.screencapture', {
      deviceId: 'emulator-5554',
      format: 'avc',
    }, new AbortController().signal)
    expect(capture.contentType).toBe('')
    const reader = capture.body.getReader()
    const first = await reader.read()
    expect(Buffer.from(first.value ?? new Uint8Array()).subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x00, 0x01]))).toBe(true)
    await reader.cancel()
  })

  it('rejects a successful direct capture response without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 200,
      headers: { 'content-type': 'video/h264' },
    })))
    const error = await rejectionOf(() => new MobilecliRpc('http://127.0.0.1:12000').stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'avc' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('answered no capture body')
  })

  it('rejects a successful capture session response without a body', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { sessionUrl: '/capture/1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { 'content-type': 'video/h264' },
      }))
    vi.stubGlobal('fetch', fetch)
    const error = await rejectionOf(() => new MobilecliRpc('http://127.0.0.1:12000').stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'avc' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('session answered no body')
  })

  it('returns a streaming capture body without buffering the whole response', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
      res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
      res.write(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    })
    const capture = await new MobilecliRpc(url).stream('device.screencapture', {
      deviceId: 'emulator-5554',
      format: 'mjpeg',
    }, new AbortController().signal)
    expect(capture.contentType).toBe('multipart/x-mixed-replace; boundary=frame')
    const reader = capture.body.getReader()
    const first = await reader.read()
    expect(Buffer.from(first.value ?? new Uint8Array()).includes(Buffer.from([0xff, 0xd8]))).toBe(true)
    await reader.cancel()
  })

  it('rejects a capture whose HTTP status is not 2xx', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(502, { 'content-type': 'video/h264' })
      res.end(Buffer.from([0x00, 0x00, 0x00, 0x01]))
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'avc' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('HTTP 502')
  })

  it('rejects a capture that answers a JSON result instead of a byte stream', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status: 'ok' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('JSON instead of a capture stream')
  })

  it('follows the 1.0.5 capture envelope: relative sessionUrl resolved against the server origin', async () => {
    let sessionPath: string | undefined
    const url = await listen((req, res) => {
      if (req.method === 'GET') {
        sessionPath = req.url
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
        return
      }
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'mjpeg', sessionUrl: '/stream?s=mjpeg' } }))
      })
    })
    const capture = await new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'mjpeg' },
      new AbortController().signal,
    )
    expect(capture.contentType).toContain('multipart/x-mixed-replace')
    const first = Buffer.from((await capture.body.getReader().read()).value ?? new Uint8Array())
    expect(first.includes(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(sessionPath).toBe('/stream?s=mjpeg')
  })

  it('follows an absolute loopback sessionUrl verbatim', async () => {
    let sessionHost: string | undefined
    const url = await listen((req, res) => {
      if (req.method === 'GET') {
        sessionHost = req.headers.host
        res.writeHead(200, { 'content-type': 'video/h264' })
        res.end(Buffer.from([0x00, 0x00, 0x00, 0x01]))
        return
      }
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'avc', sessionUrl: `${url}/stream?s=avc` } }))
      })
    })
    const capture = await new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'avc' },
      new AbortController().signal,
    )
    expect(capture.contentType).toBe('video/h264')
    expect(sessionHost).toContain('127.0.0.1')
  })

  it('rejects a capture envelope whose sessionUrl leaves the loopback fence', async () => {
    for (const sessionUrl of ['http://10.0.0.5:9/stream?s=x', 'http://evil.example/stream?s=x']) {
      const url = await listen((req, res) => {
        void body(req).then((value) => {
          const request = value as { id: number }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'mjpeg', sessionUrl } }))
        })
      })
      const error = await rejectionOf(() => new MobilecliRpc(url).stream(
        'device.screencapture',
        { deviceId: 'emulator-5554', format: 'mjpeg' },
        new AbortController().signal,
      ))
      expect(error.code).toBe('PHONE_PROTOCOL')
      expect(error.message).toContain('loopback')
    }
  })

  it('rejects an unparseable capture sessionUrl', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'mjpeg', sessionUrl: 'http://[::1' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'mjpeg' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('session URL')
  })

  it('rejects a capture session endpoint that answers non-2xx', async () => {
    const url = await listen((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('session gone')
        return
      }
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'mjpeg', sessionUrl: '/stream?s=mjpeg' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'mjpeg' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_PROTOCOL')
    expect(error.message).toContain('HTTP 503')
  })

  it('passes a session answer without a content-type header through with an empty type', async () => {
    const url = await listen((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200)
        res.end(Buffer.from([0x00]))
        return
      }
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'mjpeg', sessionUrl: '/stream?s=x' } }))
      })
    })
    const capture = await new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'mjpeg' },
      new AbortController().signal,
    )
    expect(capture.contentType).toBe('')
  })

  it('reports a refused capture session endpoint as PHONE_UNAVAILABLE', async () => {
    // A closed loopback port keeps the fence satisfied while the socket refuses.
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { format: 'mjpeg', sessionUrl: 'http://127.0.0.1:1/stream?s=mjpeg' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554', format: 'mjpeg' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_UNAVAILABLE')
  })

  it('maps a JSON-RPC error on a capture request onto PHONE_DEVICE_NOT_FOUND', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32010, message: 'gone' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'missing' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_DEVICE_NOT_FOUND')
  })

  it('wraps a capture JSON-RPC error with an upstream code as PHONE_UPSTREAM', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32050, message: 'busy' } }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_UPSTREAM')
    expect(error.message).toContain('-32050')
  })

  it('maps a refused capture socket onto PHONE_UNAVAILABLE', async () => {
    await expect(new MobilecliRpc('http://127.0.0.1:1').stream(
      'device.screencapture',
      { deviceId: 'emulator-5554' },
      new AbortController().signal,
    )).rejects.toThrow(expect.objectContaining({ code: 'PHONE_UNAVAILABLE' }))
  })

  it('wraps a capture JSON-RPC error without a code as PHONE_UPSTREAM', async () => {
    const url = await listen((req, res) => {
      void body(req).then((value) => {
        const request = value as { id: number }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} }))
      })
    })
    const error = await rejectionOf(() => new MobilecliRpc(url).stream(
      'device.screencapture',
      { deviceId: 'emulator-5554' },
      new AbortController().signal,
    ))
    expect(error.code).toBe('PHONE_UPSTREAM')
    expect(error.message).toContain('upstream error')
  })

  it('surfaces caller cancellation as PHONE_ABORTED', async () => {
    const url = await listen(() => {
      // The handler never answers; the abort must end the round trip.
    })
    const controller = new AbortController()
    const pending = new MobilecliRpc(url).call('x', {}, controller.signal)
    controller.abort()
    const error = await rejectionOf(() => pending)
    expect(error.code).toBe('PHONE_ABORTED')
  })
})

describe('normalizeOperationError', () => {
  it('passes PhoneDevicesError values through unchanged', () => {
    const original = new PhoneDevicesError('PHONE_UNAVAILABLE', 'already normalized')
    expect(normalizeOperationError(original)).toBe(original)
  })

  it('translates a dsh-timeout TimeoutReason into PHONE_TIMEOUT', () => {
    const normalized = normalizeOperationError(new TimeoutReason('LIST_CEILING', 1234))
    expect(normalized.code).toBe('PHONE_TIMEOUT')
    expect(normalized.message).toContain('1234ms')
  })

  it('names abort-shaped failures PHONE_ABORTED', () => {
    const abortLike = Object.assign(new Error('user cancelled'), { name: 'AbortError' })
    expect(normalizeOperationError(abortLike).code).toBe('PHONE_ABORTED')
  })

  it('detects connectivity codes nested under fetch-failure causes', () => {
    const inner = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const outer = new Error('fetch failed', { cause: inner })
    const normalized = normalizeOperationError(outer)
    expect(normalized.code).toBe('PHONE_UNAVAILABLE')
    expect(normalized.message).toContain('ECONNREFUSED')
  })

  it('wraps nullish throws like any other unknown failure', () => {
    expect(normalizeOperationError(null).code).toBe('PHONE_PROTOCOL')
  })

  it('wraps anything else while keeping the cause reachable', () => {
    const original = new Error('mystery')
    const normalized = normalizeOperationError(original)
    expect(normalized.code).toBe('PHONE_PROTOCOL')
    expect(normalized.cause).toBe(original)
  })
})
