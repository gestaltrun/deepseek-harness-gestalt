#!/usr/bin/env node
// Test double for the external `mobilecli` binary: a loopback JSON-RPC server
// speaking the upstream OpenRPC methods the phone runtime depends on, plus
// /__test/* control endpoints the suite uses to mutate state and observe RPC
// counters. Behavior knobs arrive through `fakemobilecli.config.json` next to
// this file, because the Service under test spawns this binary with a scrubbed
// environment of its own. Never shipped; never imported by src.

import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGradientH264, buildGradientJpeg } from './u3-visible-frames.ts'

/**
 * Vertical page-offset delta for one gesture list. A tap-shaped list, or a
 * Speak Selection long-press (pause after pointerDown before destination move),
 * keeps offset 0.
 */
function phoneSwipeScrollDelta(actions) {
  let origin
  let destination
  let pressed = false
  let longPress = false
  for (const action of actions ?? []) {
    if (action?.type === 'pointerMove' && typeof action.x === 'number' && typeof action.y === 'number') {
      if (!pressed) origin = { x: action.x, y: action.y }
      else destination = { x: action.x, y: action.y }
      continue
    }
    if (action?.type === 'pointerDown') {
      pressed = true
      if (typeof action.x === 'number' && typeof action.y === 'number' && origin === undefined) {
        origin = { x: action.x, y: action.y }
      }
      continue
    }
    if (action?.type === 'pause' && pressed && destination === undefined
      && typeof action.duration === 'number' && action.duration >= 300) {
      longPress = true
    }
  }
  if (longPress || origin === undefined || destination === undefined) return 0
  return origin.y - destination.y
}

function applyGestureScroll(deviceId, params) {
  const delta = phoneSwipeScrollDelta(params?.actions)
  const current = state.scroll[deviceId] ?? 0
  state.scroll[deviceId] = current + delta
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('mobilecli version 1.0.5\n')
  process.exit(0)
}
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

// U3: one 390×844 gradient color-bar JPEG plus a Constrained Baseline Annex-B
// stream of several I_PCM IDR pictures, generated in-process so a browser
// decoder reconstructs a visible picture instead of a 1×1 or a six-byte prefix.
let gradientJpeg
let gradientH264
function jpegFrame() {
  gradientJpeg ??= buildGradientJpeg(0)
  return gradientJpeg
}
function h264Stream() {
  gradientH264 ??= buildGradientH264()
  return gradientH264
}

const state = {
  devices: knobs.devices ?? [],
  bootCount: 0,
  shutdownCount: 0,
  infoCount: 0,
  io: [],
  captures: [],
  scroll: {},
}
let requests = 0

const listDelayMs = knobs.listDelayMs ?? 0
const listDelayAfterRequests = knobs.listDelayAfterRequests ?? 0
const hangEveryResponse = knobs.hang === true
const exitAfter = typeof knobs.exitAfter === 'number' ? knobs.exitAfter : null
// When set, the named RPC method answers with this JSON-RPC error instead of
// its normal handler; the suite pins structured real-device error arms on it.
const failArm = knobs.failArm ?? null

const AGENT_STATE_FILE = join(selfDir, 'fakemobilecli.agent-state.json')

function readAgentState() {
  try {
    return JSON.parse(readFileSync(AGENT_STATE_FILE, 'utf8'))
  } catch {
    return { installed: knobs.agent?.installed === true, installCount: 0, statusCount: 0, lastInstallArgv: null }
  }
}

function writeAgentState(agentState) {
  writeFileSync(AGENT_STATE_FILE, JSON.stringify(agentState))
}

function replyAgent(payload) {
  process.exitCode = 0
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

// CLI mode: `fakemobilecli agent status|install --device <id> ...` runs as a
// one-shot command against a persistent state file, mirroring the upstream
// agent command's JSON answers and exit codes. Server mode never reaches this.
if (args[0] === 'agent') {
  const agentKnobs = knobs.agent ?? {}
  if (agentKnobs.ignoreTerm === true) {
    process.on('SIGTERM', () => {
      // Simulate a stuck agent child that forces the caller's SIGKILL escape.
    })
  }
  const subcommand = args[1]
  const deviceIndex = args.indexOf('--device')
  const device = deviceIndex >= 0 ? (args[deviceIndex + 1] ?? null) : null
  const agentState = readAgentState()
  const failText = subcommand === 'install' ? agentKnobs.installText : agentKnobs.statusText
  const delayMs = subcommand === 'install' ? (agentKnobs.installDelayMs ?? 0) : (agentKnobs.statusDelayMs ?? 0)
  setTimeout(() => {
    if (typeof failText === 'string') {
      process.exitCode = subcommand === 'install' ? (agentKnobs.installExitCode ?? 1) : (agentKnobs.statusExitCode ?? 1)
      process.stderr.write(`${failText}\n`)
      return
    }
    if (subcommand === 'status') {
      agentState.statusCount += 1
      writeAgentState(agentState)
      if (typeof agentKnobs.statusAnswer === 'string') {
        process.exitCode = 0
        process.stdout.write(`${agentKnobs.statusAnswer}\n`)
        return
      }
      if (agentState.installed) {
        replyAgent({ status: 'ok', data: { message: 'Agent version 0.0.0-test is installed on device', agent: { version: '0.0.0-test', bundleId: 'com.mobilenext.devicekit-iosUITests.xctrunner' } } })
        return
      }
      replyAgent({ status: 'fail', data: { message: 'Agent is not installed on the device' } })
      return
    }
    if (subcommand === 'install') {
      agentState.installCount += 1
      agentState.lastInstallArgv = [...args]
      writeAgentState(agentState)
      const deviceEntry = state.devices.find(candidate => candidate.id === device)
      if (deviceEntry?.platform === 'ios' && deviceEntry.type === 'real' && !args.includes('--provisioning-profile')) {
        process.exitCode = 1
        process.stderr.write('--provisioning-profile is required for real iOS devices\n')
        return
      }
      agentState.installed = true
      writeAgentState(agentState)
      if (typeof agentKnobs.installAnswer === 'string') {
        process.exitCode = 0
        process.stdout.write(`${agentKnobs.installAnswer}\n`)
        return
      }
      replyAgent({ status: 'ok', data: { message: 'Agent installed successfully', agent: { version: '0.0.0-test', bundleId: 'com.mobilenext.devicekit-iosUITests.xctrunner' } } })
      return
    }
    process.exitCode = 1
    process.stderr.write(`unknown agent subcommand: ${String(subcommand)}\n`)
  }, delayMs)
}

function reply(res, id, payload) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }))
}

// One capture payload: an MJPEG multipart stream or a raw H264 Annex-B stream.
// With streamFrameCount the MJPEG body stays open, emitting a frame every 40ms
// until the client disconnects — so a mid-stream teardown reaches the proxy.
function serveCapture(res, format, deviceId) {
  state.captures.push({ deviceId, format })
  if (format === 'avc') {
    res.writeHead(200, { 'content-type': 'video/h264', 'cache-control': 'no-store' })
    if (knobs.h264FailureDeviceIds?.includes(deviceId) === true) {
      res.end('Error: Error 0x80001001')
      return
    }
    res.write(h264Stream())
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store' })
  const frameCount = knobs.streamFrameCount ?? 1
  let sent = 0
  const emitFrame = () => {
    sent += 1
    const jpeg = jpegFrame()
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(jpeg.length)}\r\n\r\n`)
    res.write(jpeg)
    res.write('\r\n')
    if (sent >= frameCount) {
      res.write('--frame--\r\n')
      res.end()
      return
    }
    setTimeout(emitFrame, 40)
  }
  emitFrame()
}

async function handleRpc(req, res) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const request = JSON.parse(raw)
  const { id, method, params } = request ?? {}
  requests += 1
  if (hangEveryResponse) return
  if (failArm !== null && failArm.method === method) {
    reply(res, id, { error: { code: failArm.code ?? -32000, message: failArm.message } })
    return
  }
  if (listDelayMs > 0 && requests > listDelayAfterRequests && method === 'devices.list') {
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
      const entries = state.devices.filter(device => includeOffline || device.state === 'online').map(device => ({
        ...device,
        provider: { type: 'local' },
      }))
      // Real mobilecli 1.0.5 wraps the array in a `{ devices: [...] }` envelope.
      reply(res, id, { result: knobs.listEnvelope === true ? { devices: entries } : entries })
      return
    }
    case 'device.info': {
      const deviceId = params?.deviceId
      const device = state.devices.find(candidate => candidate.id === deviceId)
      if (device === undefined) {
        reply(res, id, { error: { code: -32010, message: `no device ${String(deviceId)}` } })
        return
      }
      state.infoCount += 1
      const infoDelayMs = knobs.infoDelayMs ?? 0
      if (infoDelayMs > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, infoDelayMs))
      reply(res, id, {
        result: {
          device: {
            ...device,
            screenSize: device.screenSize ?? (device.platform === 'ios'
              ? { width: 402, height: 874, scale: 3 }
              : { width: 390, height: 844, scale: 1 }),
          },
        },
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
      // An unauthorized handset accepts no io until its trust prompt is
      // accepted; the message deliberately names no #362 classifier arm, so
      // the structured cause stays on the listing's state field.
      if (device.state === 'unauthorized') {
        reply(res, id, { error: { code: -32000, message: 'the device is unauthorized; accept the trust prompt on the device' } })
        return
      }
      state.io.push({ method, params })
      if (method === 'device.io.gesture') applyGestureScroll(String(deviceId), params)
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
      // Real mobilecli 1.0.5 answers with a session envelope; the stream then
      // lives on the separate /stream?s= endpoint this server also serves.
      if (knobs.captureEnvelope === true) {
        const device = knobs.h264FailureDeviceIds === undefined
          ? ''
          : `&deviceId=${encodeURIComponent(String(deviceId))}`
        reply(res, id, { result: { format, sessionUrl: `/stream?s=${format}${device}` } })
        return
      }
      serveCapture(res, format, String(deviceId))
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
      // Session endpoint of the 1.0.5 capture contract: the stream lives here,
      // addressed by the `s` parameter the envelope hands out. The
      // dualBoundaryStream knob reproduces the real R4 body: JSON notifications
      // under the declared --BoundaryString family, then image frames under an
      // undeclared --mjpeg-frame-boundary family.
      if (req.method === 'GET' && (req.url === '/stream' || (req.url ?? '').startsWith('/stream?'))) {
        const s = new URL(req.url ?? '/stream', 'http://127.0.0.1').searchParams.get('s')
        if (knobs.dualBoundaryStream === true) {
          const json = JSON.stringify({ notification: 'message', message: 'Starting video stream' })
          const body = Buffer.concat([
            Buffer.from(`--BoundaryString\r\nContent-Type: application/json\r\n\r\n${json}\r\n`),
            Buffer.from('--BoundaryString--\r\n'),
            Buffer.from(`--mjpeg-frame-boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(jpegFrame().length)}\r\n\r\n`),
            jpegFrame(),
            Buffer.from(`\r\n--mjpeg-frame-boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(jpegFrame().length)}\r\n\r\n`),
            jpegFrame(),
            Buffer.from('\r\n--mjpeg-frame-boundary--\r\n'),
          ])
          res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=BoundaryString', 'cache-control': 'no-store' })
          res.write(body)
          res.end()
          return
        }
        const deviceId = new URL(req.url ?? '/stream', 'http://127.0.0.1').searchParams.get('deviceId') ?? ''
        serveCapture(res, s === 'avc' ? 'avc' : 'mjpeg', deviceId)
        return
      }
      if (req.method === 'GET' && req.url === '/__test/counters') {
        reply(res, undefined, {
          requests,
          bootCount: state.bootCount,
          shutdownCount: state.shutdownCount,
          infoCount: state.infoCount,
          io: state.io,
          captures: state.captures,
          scroll: state.scroll,
        })
        return
      }
      if (req.method === 'GET' && req.url === '/__test/pid') {
        reply(res, undefined, { pid: process.pid, ownerToken: knobs.ownerToken })
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

// Server startup never runs in agent CLI mode, which exits from its own timer.
if (args[0] !== 'agent') {
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
}
