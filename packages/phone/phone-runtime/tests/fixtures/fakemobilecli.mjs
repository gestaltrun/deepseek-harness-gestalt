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

// Canonical baseline 1×1 JPEG (JFIF APP0, two DQTs, SOF0 1×1, four DHTs, SOS,
// entropy data, EOI): a frame any standard decoder accepts, unlike a bare
// SOI+EOI marker pair.
const JPEG_1X1 = Buffer.from(
  'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda000c03010002110311003f00f7fa28a2803fffd9',
  'hex',
)
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
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(0)
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
      process.stderr.write(`${failText}\n`)
      process.exit(subcommand === 'install' ? (agentKnobs.installExitCode ?? 1) : (agentKnobs.statusExitCode ?? 1))
    }
    if (subcommand === 'status') {
      agentState.statusCount += 1
      writeAgentState(agentState)
      if (agentState.installed) {
        replyAgent({ status: 'ok', data: { message: 'Agent version 0.0.0-test is installed on device', agent: { version: '0.0.0-test', bundleId: 'com.mobilenext.devicekit-iosUITests.xctrunner' } } })
      }
      replyAgent({ status: 'fail', data: { message: 'Agent is not installed on the device' } })
    }
    if (subcommand === 'install') {
      agentState.installCount += 1
      agentState.lastInstallArgv = [...args]
      writeAgentState(agentState)
      const deviceEntry = state.devices.find(candidate => candidate.id === device)
      if (deviceEntry?.type === 'real' && !args.includes('--provisioning-profile')) {
        process.stderr.write('--provisioning-profile is required for real iOS devices\n')
        process.exit(1)
      }
      agentState.installed = true
      writeAgentState(agentState)
      if (typeof agentKnobs.installAnswer === 'string') {
        process.stdout.write(`${agentKnobs.installAnswer}\n`)
        process.exit(0)
      }
      replyAgent({ status: 'ok', data: { message: 'Agent installed successfully', agent: { version: '0.0.0-test', bundleId: 'com.mobilenext.devicekit-iosUITests.xctrunner' } } })
    }
    process.stderr.write(`unknown agent subcommand: ${String(subcommand)}\n`)
    process.exit(1)
  }, delayMs)
}

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
  if (failArm !== null && failArm.method === method) {
    reply(res, id, { error: { code: failArm.code ?? -32000, message: failArm.message } })
    return
  }
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
      const entries = state.devices.filter(device => includeOffline || device.state === 'online').map(device => ({
        ...device,
        provider: { type: 'local' },
      }))
      // Real mobilecli 1.0.5 wraps the array in a `{ devices: [...] }` envelope.
      reply(res, id, { result: knobs.listEnvelope === true ? { devices: entries } : entries })
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
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(JPEG_1X1.length)}\r\n\r\n`)
      res.write(JPEG_1X1)
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
