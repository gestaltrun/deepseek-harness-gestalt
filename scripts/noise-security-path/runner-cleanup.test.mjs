/** Failure-path coverage for disposable native proof runner resources. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runAndroidProof } from './run-android.mjs'
import { runIosProof } from './run-ios.mjs'

const iosDevice = { name: 'iPhone Test', state: 'Shutdown', udid: 'IOS-TEST' }

describe('iOS proof runner cleanup', () => {
  for (const failure of ['build', 'install', 'launch']) {
    it(`releases every acquired resource after ${failure} failure`, async () => {
      const harness = createIosHarness(failure)
      await assert.rejects(runIosProof(harness.adapters), new RegExp(`${failure} failed`))
      assertOrdered(harness.calls, 'simctl shutdown IOS-TEST', 'list devices IOS-TEST --json')
      assertOrdered(
        harness.calls,
        'simctl terminate IOS-TEST dev.deepseek.noiseproof',
        'simctl uninstall IOS-TEST dev.deepseek.noiseproof',
        'simctl shutdown IOS-TEST',
      )
    })
  }

  it('preserves a boot failure while reporting cleanup failure and awaiting Shutdown', async () => {
    const harness = createIosHarness('boot', { shutdownFails: true })
    await assert.rejects(runIosProof(harness.adapters), error => {
      assert(error instanceof AggregateError)
      assert.match(error.errors[0].message, /boot failed/)
      assert.match(error.errors[1].message, /simctl shutdown exited with 1/)
      return true
    })
    assertOrdered(
      harness.calls,
      'simctl boot IOS-TEST',
      'simctl shutdown IOS-TEST',
      'list devices IOS-TEST --json',
    )
  })

  it('reports cleanup failure without skipping the shutdown-state wait', async () => {
    const harness = createIosHarness('build', { shutdownFails: true })
    await assert.rejects(runIosProof(harness.adapters), error => {
      assert(error instanceof AggregateError)
      assert.match(error.message, /build failed; 1 cleanup action\(s\) failed/)
      assert.match(error.errors[0].message, /build failed/)
      assert.match(error.errors[1].message, /simctl shutdown exited with 1/)
      return true
    })
    assertOrdered(harness.calls, 'simctl shutdown IOS-TEST', 'list devices IOS-TEST --json')
  })
})

describe('Android proof runner cleanup', () => {
  for (const failure of ['wait', 'boot', 'install', 'launch']) {
    it(`terminates and awaits its Emulator after ${failure} failure`, async () => {
      const harness = createAndroidHarness(failure)
      await assert.rejects(runAndroidProof('/fake/noise-proof.apk', harness.adapters))
      assertOrdered(harness.calls, 'adb emu kill', 'emulator waitForExit')
      if (failure === 'install' || failure === 'launch') {
        assertOrdered(
          harness.calls,
          'adb shell am force-stop dev.deepseek.noiseproof',
          'adb uninstall dev.deepseek.noiseproof',
          'adb emu kill',
        )
      }
    })
  }

  it('preserves the primary failure and observes process exit when Emulator kill fails', async () => {
    const harness = createAndroidHarness('wait', { killFails: true })
    await assert.rejects(
      runAndroidProof('/fake/noise-proof.apk', harness.adapters),
      error => {
        assert(error instanceof AggregateError)
        assert.match(error.errors[0].message, /wait failed/)
        assert.match(error.errors[1].message, /adb emu kill exited with 1/)
        return true
      },
    )
    assertOrdered(
      harness.calls,
      'adb emu kill',
      'emulator terminate',
      'emulator waitForExit',
    )
  })

  it('allows an existing Emulator thirty seconds to cold-start its WebView report', async () => {
    let time = 0
    const report = JSON.stringify({ runtime: 'Android WebView', allPass: true })
    const commands = {
      execFileSync(_command, args) {
        if (args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice\n'
        if (args.join(' ') === 'shell getprop ro.build.version.sdk') return '34\n'
        if (args.join(' ') === 'shell dumpsys package com.android.webview') return 'versionName=1.2.3\n'
        return ''
      },
      spawnSync(_command, args) {
        if (args.join(' ') === 'shell getprop sys.boot_completed') return { status: 0, stdout: '1\n' }
        if (args.join(' ') === 'shell run-as dev.deepseek.noiseproof cat files/noise-proof.json') {
          return time >= 20_000 ? { status: 0, stdout: report } : { status: 1, stdout: '' }
        }
        return { status: 0, stdout: '' }
      },
    }

    await assert.doesNotReject(runAndroidProof('/fake/noise-proof.apk', {
      clock: { now: () => time, sleep: async delay => { time += delay } },
      commands,
    }))
  })
})

/**
 * Create a fake iOS command surface that fails at one owned phase.
 * @param {string} failure Failure phase.
 * @param {{ shutdownFails?: boolean }} options Cleanup behavior.
 * @returns {{ adapters: object, calls: string[] }} Harness.
 */
function createIosHarness(failure, options = {}) {
  const calls = []
  const commands = {
    execFileSync(command, args) {
      const invocation = `${command} ${args.join(' ')}`
      calls.push(invocation)
      if (args.join(' ') === 'simctl list devices available --json') {
        return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-Test': [iosDevice] } })
      }
      if (args.join(' ') === 'simctl list devices IOS-TEST --json') {
        return JSON.stringify({ devices: { runtime: [{ ...iosDevice, state: 'Shutdown' }] } })
      }
      if (args[1] === 'boot' && failure === 'boot') throw new Error('boot failed')
      if (command === 'xcodebuild' && failure === 'build') throw new Error('build failed')
      if (args[1] === 'install' && failure === 'install') throw new Error('install failed')
      if (args[1] === 'launch' && failure === 'launch') throw new Error('launch failed')
      return ''
    },
    spawnSync(command, args) {
      calls.push(`${command} ${args.join(' ')}`)
      if (args[1] === 'shutdown' && options.shutdownFails) return { status: 1 }
      return { status: 0, stdout: '' }
    },
  }
  return {
    adapters: {
      clock: { now: () => 0, sleep: async () => {} },
      commands,
      files: { existsSync: () => false, readFileSync: () => '' },
    },
    calls,
  }
}

/**
 * Create a fake Android command surface that fails at one owned phase.
 * @param {string} failure Failure phase.
 * @param {{ killFails?: boolean }} options Cleanup behavior.
 * @returns {{ adapters: object, calls: string[] }} Harness.
 */
function createAndroidHarness(failure, options = {}) {
  const calls = []
  let time = 0
  const commands = {
    execFileSync(_command, args) {
      calls.push(`adb ${args.join(' ')}`)
      if (args[0] === 'devices') return 'List of devices attached\n'
      if (args[0] === 'wait-for-device' && failure === 'wait') throw new Error('wait failed')
      if (args[0] === 'install' && failure === 'install') throw new Error('install failed')
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start' && failure === 'launch') {
        throw new Error('launch failed')
      }
      return ''
    },
    spawnSync(_command, args) {
      calls.push(`adb ${args.join(' ')}`)
      if (args.join(' ') === 'shell getprop sys.boot_completed') {
        return { status: 0, stdout: failure === 'boot' ? '0\n' : '1\n' }
      }
      if (args.join(' ') === 'emu kill' && options.killFails) return { status: 1 }
      return { status: 0, stdout: '' }
    },
  }
  return {
    adapters: {
      clock: {
        now: () => time,
        sleep: async delay => { time += delay },
      },
      commands,
      startEmulator: () => ({
        terminate: () => calls.push('emulator terminate'),
        waitForExit: async () => { calls.push('emulator waitForExit') },
      }),
    },
    calls,
  }
}

/**
 * Assert that expected call fragments appear in order.
 * @param {string[]} calls Recorded calls.
 * @param {...string} expected Ordered fragments.
 * @returns {void}
 */
function assertOrdered(calls, ...expected) {
  let cursor = -1
  for (const fragment of expected) {
    cursor = calls.findIndex((call, index) => index > cursor && call.includes(fragment))
    assert.notEqual(cursor, -1, `missing ${fragment} after ${calls.join(' | ')}`)
  }
}
