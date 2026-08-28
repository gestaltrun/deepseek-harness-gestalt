#!/usr/bin/env node
// Test double for the external `mobilecli` binary: a loopback JSON-RPC server
// speaking the upstream OpenRPC methods the phone runtime depends on, plus
// /__test/* control endpoints the suite uses to mutate state and observe RPC
// counters. Behavior knobs arrive through `fakemobilecli.config.json` next to
// this file, because the Service under test spawns this binary with a scrubbed
// environment of its own. Never shipped; never imported by src.

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const listenIndex = args.indexOf('--listen')
const address = listenIndex >= 0 ? (args[listenIndex + 1] ?? '127.0.0.1:12000') : '127.0.0.1:12000'
const port = Number(address.split(':').at(-1))

const selfDir = dirname(fileURLToPath(import.meta.url))
const knobs = (() => {
  try {
    return JSON.parse(readFileSync(join(selfDir, 'fakemobilecli.config.json'), 'utf8'))
  } catch {
    return {}
  }
})()

if (knobs.ignoreTerm === true) {
  process.on('SIGTERM', () => {
    // Simulate a slow shutdown that forces the caller's SIGKILL escape.
  })
}

if (knobs.exitFast === true) {
  process.stderr.write('fakemobilecli exiting immediately\n')
  process.exit(9)
}

const JPEG_SOI_EOI = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const H264_ANNEX_B = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42])

const state = {
  devices: knobs.devices ?? [],
  bootCount: 0,
  shutdownCount: 0,
  io: [],
}
let requests = 0

const listDelayMs = knobs.listDelayMs ?? 0
const hangEveryResponse = knobs.hang === true
const exitAfter = typeof knobs.exitAfter === 'number' ? knobs.exitAfter : null

function reply(res, id, payload) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }))
}

async function handleRpc(req, res) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const request = JSON.parse(raw)
  const { id, method, params } = request ?? {}
  requests += 1
  if (hangEveryResponse) return
  if (listDelayMs > 0 && method === 'devices.list') {
    await new Promise(resolveDelay => setTimeout(resolveDelay, listDelayMs))
  }
  // The exit knob fires only after the real method reply, so response content
  // always matches the method the caller issued.
  if (exitAfter !== null && requests >= exitAfter) {
    res.on('finish', () => {
      setTimeout(() => process.exit(87), 5)
    })
  }
  switch (method) {
    case 'server.info': {
      reply(res, id, { result: { name: 'fakemobilecli', version: '0.0.0-test' } })
      return
    }
    case 'devices.list': {
      const includeOffline = params?.includeOffline === true
      reply(res, id, {
        result: state.devices.filter(device => includeOffline || device.state === 'online').map(device => ({
          ...device,
          provider: { type: 'local' },
        })),
      })
      return
    }
    case 'device.boot':
    case 'device.shutdown': {
      const deviceId = params?.deviceId
      const device = state.devices.find(candidate => candidate.id === deviceId)
      if (device === undefined) {
        reply(res, id, { error: { code: -32010, message: `no device ${String(deviceId)}` } })
        return
      }
      if (device.type === 'real') {
        // Upstream restricts lifecycle verbs to simulators/emulators.
        reply(res, id, { error: { code: -32000, message: 'real devices support no such operation' } })
        return
      }
      if (method === 'device.boot') {
        state.bootCount += 1
        device.state = 'online'
      } else {
        state.shutdownCount += 1
        device.state = 'offline'
      }
      reply(res, id, { result: { status: 'ok' } })
      return
    }
    case 'device.io.tap':
    case 'device.io.gesture':
    case 'device.io.text':
    case 'device.io.button': {
      const deviceId = params?.deviceId
      const device = state.devices.find(candidate => candidate.id === deviceId)
      if (device === undefined) {
        reply(res, id, { error: { code: -32010, message: `no device ${String(deviceId)}` } })
        return
      }
      state.io.push({ method, params })
      reply(res, id, { result: { status: 'ok' } })
      return
    }
    case 'device.screencapture': {
      const deviceId = params?.deviceId
      const device = state.devices.find(candidate => candidate.id === deviceId)
      if (device === undefined) {
        reply(res, id, { error: { code: -32010, message: `no device ${String(deviceId)}` } })
        return
      }
      const captureDelayMs = knobs.screencaptureDelayMs ?? 0
      if (captureDelayMs > 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, captureDelayMs))
      }
      const format = params?.format === 'avc' ? 'avc' : 'mjpeg'
      if (format === 'avc') {
        res.writeHead(200, { 'content-type': 'video/h264', 'cache-control': 'no-store' })
        res.write(H264_ANNEX_B)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store' })
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(JPEG_SOI_EOI.length)}\r\n\r\n`)
      res.write(JPEG_SOI_EOI)
      res.write('\r\n--frame--\r\n')
      res.end()
      return
    }
    default: {
      reply(res, id, { error: { code: -32601, message: `method ${String(method)} not found` } })
    }
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === 'GET' && req.url === '/__test/counters') {
        reply(res, undefined, { requests, bootCount: state.bootCount, shutdownCount: state.shutdownCount, io: state.io })
        return
      }
      if (req.method === 'GET' && req.url === '/__test/pid') {
        reply(res, undefined, { pid: process.pid })
        return
      }
      if (req.method === 'POST' && req.url === '/__test/set-devices') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        state.devices = JSON.parse(raw).devices
        reply(res, undefined, { ok: true })
        return
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        await handleRpc(req, res)
        return
      }
      res.statusCode = 404
      res.end()
    } catch (error) {
      reply(res, null, { error: { code: -32000, message: String(error) } })
    }
  })()
})

process.stderr.write(`fakemobilecli listening on ${address}\n`)
let listenAttempts = 0
server.on('error', (error) => {
  // The staged port is claimed, but a straggler can still hold it briefly.
  if (error.code === 'EADDRINUSE' && listenAttempts < 50) {
    listenAttempts += 1
    setTimeout(() => {
      server.listen(port, '127.0.0.1')
    }, 40)
    return
  }
  process.stderr.write(`fakemobilecli listen failed: ${String(error)}\n`)
  process.exit(1)
})
server.listen(port, '127.0.0.1')
