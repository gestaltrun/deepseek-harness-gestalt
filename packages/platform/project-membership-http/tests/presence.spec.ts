/**
 * Presence registry semantics driven by a fake clock: heartbeat registration,
 * TTL expiry, per-account aggregation across installations, and the offline
 * default for accounts that never registered.
 */

import { describe, expect, it } from 'vitest'
import type { InstallationId, PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { InProcessPresenceStore, PresenceRegistry } from '../src/presence.ts'

const OCTOCAT = 'presence-octocat' as PlatformAccountId
const MONA = 'presence-mona' as PlatformAccountId

const desktop = (name: string): InstallationId => `install-${name}` as InstallationId

describe('PresenceRegistry', () => {
  it('keeps a beat online for the TTL and drops it at expiry', async () => {
    let now = 1_000
    const registry = new PresenceRegistry(new InProcessPresenceStore(), 90_000, () => now)
    await registry.beat(OCTOCAT, desktop('a'))
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set([OCTOCAT]))
    now += 89_999
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set([OCTOCAT]))
    now += 1
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set())
  })

  it('keeps an account online while any of its installations holds a live heartbeat', async () => {
    let now = 0
    const registry = new PresenceRegistry(new InProcessPresenceStore(), 50, () => now)
    await registry.beat(OCTOCAT, desktop('a'))
    now += 30
    await registry.beat(OCTOCAT, desktop('b'))
    now += 30
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set([OCTOCAT]))
    now += 20
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set())
  })

  it('keeps a steady caller online across refreshes', async () => {
    let now = 0
    const registry = new PresenceRegistry(new InProcessPresenceStore(), 90, () => now)
    await registry.beat(OCTOCAT, desktop('a'))
    now += 60
    await registry.beat(OCTOCAT, desktop('a'))
    now += 60
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set([OCTOCAT]))
    now += 91
    expect(await registry.onlineAccountIds([OCTOCAT])).toEqual(new Set())
  })

  it('answers offline for accounts that never registered', async () => {
    const registry = new PresenceRegistry(new InProcessPresenceStore(), 90_000, () => 0)
    await registry.beat(OCTOCAT, desktop('a'))
    expect(await registry.onlineAccountIds([MONA])).toEqual(new Set())
  })

  it('rejects a non-positive TTL', () => {
    expect(() => new PresenceRegistry(new InProcessPresenceStore(), 0)).toThrow('positive integer')
  })
})
