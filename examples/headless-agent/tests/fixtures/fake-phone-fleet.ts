/** Test-only `phoneDevices` provider: the tool-phone spec fleet plus an on-disk call journal. */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'fake-phone-fleet'
export const inject = []

/** Same listing as the tool-phone spec fake: one online Android emulator, one offline iOS simulator, one online iOS real. */
const LISTING = {
  android: [{
    id: 'emulator-5554',
    name: 'Pixel_6',
    kind: 'emulator',
    platform: 'android',
    state: 'online',
    online: true,
  }],
  ios: {
    simulators: [{
      id: 'SIM-UDID',
      name: 'iPhone 16',
      kind: 'simulator',
      platform: 'ios',
      state: 'shutdown',
      online: false,
    }],
    reals: [{
      id: 'REAL-UDID',
      name: 'iPhone',
      kind: 'real',
      platform: 'ios',
      state: 'online',
      online: true,
    }],
  },
}

/** The journal lands beside the spawned process cwd; the snapshot inspect reads it to assert the listing plus one closed tap. */
const JOURNAL_PATH = join(process.cwd(), 'phone-fleet-journal.json')

const calls: { op: string; deviceId?: string }[] = []
const readinessListeners = new Set<(ready: boolean) => void>()
let ready = true

function record(op: string, deviceId?: string): void {
  calls.push(deviceId === undefined ? { op } : { op, deviceId })
  writeFileSync(JOURNAL_PATH, `${JSON.stringify(calls, null, 2)}\n`, 'utf8')
}

/** Provide the recording fake under the `phoneDevices` service name tool-phone injects. */
export function apply(ctx: Context): void {
  ctx.provide('phoneDevices', {
    isReady() { return ready },
    onReadinessChanged(listener: (next: boolean) => void) {
      readinessListeners.add(listener)
      return () => { readinessListeners.delete(listener) }
    },
    async listDevices() {
      record('listDevices')
      return LISTING
    },
    async boot(deviceId: string) { record('boot', deviceId) },
    async shutdown(deviceId: string) { record('shutdown', deviceId) },
    async io() {
      record('io')
      ready = false
      for (const listener of [...readinessListeners]) listener(false)
    },
    async screenshot(deviceId: string) {
      record('screenshot', deviceId)
      return { mediaType: 'image/png' as const, path: '/tmp/dsh-home/phone/screenshots/emulator-5554.png' }
    },
  } as never)
}
