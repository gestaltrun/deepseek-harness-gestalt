/**
 * Phone settings card controller: enable-flag projection, missing-service
 * probe-failed view, and the next-action / copy callbacks.
 */
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  MISSING_PHONE_ENVIRONMENT_SOURCE, PROBE_FAILED_ERROR, resolvePhoneCardView,
  type PhoneEnvironmentSource, type PhoneEnvironmentView,
} from '../src/client/phone-environment.ts'
import { PhoneSettingsCardController } from '../src/client/phone-settings-controller.ts'
import { MISSING_PHONE_ENVIRONMENT, type PhoneRuntimeSource } from '../src/client/phone-runtime-source.ts'
import { createListingPhoneEnvironmentSource } from '../src/client/phone-environment-listing.ts'
import { FakeListingSource, flush, listingOf } from './phone-fakes.client.ts'
import type { PhoneSettings } from '../src/phone-settings.ts'

function readyScope(enabled: boolean) {
  const host = stubSettingsScope<PhoneSettings>()
  host.publish({
    status: 'ready',
    writable: true,
    value: { enabled },
    base: { enabled: false },
    user: enabled ? { enabled: true } : {},
    revision: 1,
  })
  return host
}

describe('resolvePhoneCardView', () => {
  it('keeps the off chrome while the plugin is disabled', () => {
    expect(resolvePhoneCardView(false, MISSING_PHONE_ENVIRONMENT_SOURCE)).toEqual({ kind: 'off' })
  })

  it('uses the missing-service source as the probe-failed view', () => {
    expect(resolvePhoneCardView(true, MISSING_PHONE_ENVIRONMENT_SOURCE)).toEqual({
      kind: 'errors',
      errors: [PROBE_FAILED_ERROR],
    })
  })
})

describe('PhoneSettingsCardController first-open auto-detect', () => {
  it('auto-probes when enable arrives after construction: probing paints, ready lands', async () => {
    const listing = new FakeListingSource().seed(listingOf([
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
    ]))
    // The real card constructs at apply time, before the scope hydrates —
    // the enable flip arrives later and must kick the one auto-detect.
    const host = stubSettingsScope<PhoneSettings>()
    const controller = new PhoneSettingsCardController(host.scope, createListingPhoneEnvironmentSource(listing))
    const face = controller.inject()
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true },
      base: { enabled: false },
      user: { enabled: true },
      revision: 1,
    })
    // The first enabled paint is the probing view — never the probe-failed
    // arm the stale phase used to settle on while the pull was in flight.
    expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('probing')
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('ready')
    })
    expect(listing.refreshCount).toBe(1)
    controller.dispose()
  })

  it('auto-probes on construction when the deployment is already enabled', async () => {
    const listing = new FakeListingSource().seed(listingOf([
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
    ]))
    const host = readyScope(true)
    const controller = new PhoneSettingsCardController(host.scope, createListingPhoneEnvironmentSource(listing))
    const face = controller.inject()
    expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('probing')
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('ready')
    })
    expect(listing.refreshCount).toBe(1)
    controller.dispose()
  })

  it('falls to the probe-failed arm only when the auto-probe itself fails', async () => {
    const listing = new FakeListingSource()
    listing.scriptNext(Promise.reject(new Error('host down')))
    const host = readyScope(true)
    const controller = new PhoneSettingsCardController(host.scope, createListingPhoneEnvironmentSource(listing))
    const face = controller.inject()
    expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('probing')
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('errors')
    })
    // A disabled deployment never pulls.
    const idle = new FakeListingSource()
    const off = new PhoneSettingsCardController(readyScope(false).scope, createListingPhoneEnvironmentSource(idle))
    await flush()
    expect(off.inject().hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('off')
    expect(idle.refreshCount).toBe(0)
    controller.dispose()
    off.dispose()
  })
})

describe('PhoneSettingsCardController publish re-entrancy', () => {
  it('never re-kicks ensureDetected from a subscribe callback (P17 recursion cut)', async () => {
    // An UNGUARDED source: every ensureDetected runs detect, which notifies.
    // The controller's re-entrant publish must not kick it again — the
    // kick happens at most once per publish wave, so the recursion the
    // acceptance run hit (publish → ensureDetected → notify → publish)
    // terminates instead of blowing the stack.
    let kicks = 0
    const listeners = new Set<() => void>()
    let view: PhoneEnvironmentView = { kind: 'probing', checks: [] }
    const detect = async (): Promise<void> => {
      view = { kind: 'android-wizard', platformToolsInstalled: true }
      for (const listener of [...listeners]) listener()
    }
    const source: PhoneEnvironmentSource = {
      getView: () => view,
      redetect: detect,
      ensureDetected: () => {
        kicks += 1
        void detect()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const host = readyScope(true)
    const controller = new PhoneSettingsCardController(host.scope, source)
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({
        kind: 'android-wizard', platformToolsInstalled: true,
      })
    })
    expect(kicks).toBe(1)
    controller.dispose()
  })
})

describe('PhoneSettingsCardController', () => {
  it('keeps the runtime subscription across environment-source replacement and disposes it', () => {
    const runtimeListeners = new Set<() => void>()
    const dispose = vi.fn()
    const runtime: PhoneRuntimeSource = {
      getSnapshot: () => ({
        revision: 0,
        enabled: false,
        runtime: { kind: 'missing', targetVersion: '1.0.5' },
        platforms: { android: { kind: 'deferred' }, ios: { kind: 'deferred' } },
      }),
      refresh: async () => {},
      prepare: async () => {},
      cancel: async () => {},
      prepareAndroid: async () => {},
      cancelAndroid: async () => {},
      refreshAndroid: async () => {},
      startAndroid: async () => {},
      prepareIos: async () => {},
      cancelIos: async () => {},
      refreshIos: async () => {},
      startIos: async () => {},
      ensureDetected: () => {},
      dispose,
      subscribe: (listener) => {
        runtimeListeners.add(listener)
        return () => { runtimeListeners.delete(listener) }
      },
    }
    const controller = new PhoneSettingsCardController(
      readyScope(false).scope, MISSING_PHONE_ENVIRONMENT_SOURCE, undefined, runtime,
    )
    expect(runtimeListeners.size).toBe(1)
    controller.setSource(MISSING_PHONE_ENVIRONMENT_SOURCE)
    expect(runtimeListeners.size).toBe(1)
    controller.dispose()
    expect(runtimeListeners.size).toBe(0)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('republishes runtime snapshots and contains rejected runtime operations', async () => {
    const runtimeListeners = new Set<() => void>()
    let runtimeSnapshot: ReturnType<PhoneRuntimeSource['getSnapshot']> = {
      revision: 0,
      enabled: false,
      runtime: { kind: 'missing', targetVersion: '1.0.5' },
      platforms: { android: { kind: 'deferred' }, ios: { kind: 'deferred' } },
    }
    const refresh = vi.fn(async () => { throw new Error('refresh failed') })
    const prepare = vi.fn(async () => { throw new Error('prepare failed') })
    const cancel = vi.fn(async () => { throw new Error('cancel failed') })
    const prepareAndroid = vi.fn(async () => { throw new Error('Android prepare failed') })
    const cancelAndroid = vi.fn(async () => { throw new Error('Android cancel failed') })
    const refreshAndroid = vi.fn(async () => { throw new Error('Android refresh failed') })
    const startAndroid = vi.fn(async () => { throw new Error('Android start failed') })
    const prepareIos = vi.fn(async () => { throw new Error('iOS prepare failed') })
    const cancelIos = vi.fn(async () => { throw new Error('iOS cancel failed') })
    const refreshIos = vi.fn(async () => { throw new Error('iOS refresh failed') })
    const startIos = vi.fn(async () => { throw new Error('iOS start failed') })
    const runtime: PhoneRuntimeSource = {
      getSnapshot: () => runtimeSnapshot,
      refresh,
      prepare,
      cancel,
      prepareAndroid,
      cancelAndroid,
      refreshAndroid,
      startAndroid,
      prepareIos,
      cancelIos,
      refreshIos,
      startIos,
      ensureDetected: vi.fn(),
      dispose: vi.fn(),
      subscribe: (listener) => {
        runtimeListeners.add(listener)
        return () => { runtimeListeners.delete(listener) }
      },
    }
    const controller = new PhoneSettingsCardController(
      readyScope(false).scope, MISSING_PHONE_ENVIRONMENT_SOURCE, undefined, runtime,
    )
    const face = controller.inject()
    runtimeSnapshot = {
      revision: 1,
      enabled: false,
      runtime: { kind: 'ready', version: '1.0.5', source: 'managed' },
      platforms: { android: { kind: 'deferred' }, ios: { kind: 'unsupported', reason: 'macOS required' } },
    }
    for (const listener of runtimeListeners) listener()
    expect(face.hooks.phoneSettingsCard.getSnapshot()).toMatchObject({
      runtime: { kind: 'ready', version: '1.0.5', source: 'managed' },
      platforms: { ios: { kind: 'unsupported', reason: 'macOS required' } },
    })

    face.prepareRuntime()
    face.cancelRuntime()
    face.refreshRuntime()
    face.prepareAndroid()
    face.cancelAndroid()
    face.refreshAndroid()
    face.startAndroid()
    face.prepareIos()
    face.cancelIos()
    face.refreshIos()
    face.startIos()
    face.nextAction('mobilecli-missing')
    await flush()
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(prepareAndroid).toHaveBeenCalledOnce()
    expect(cancelAndroid).toHaveBeenCalledOnce()
    expect(refreshAndroid).toHaveBeenCalledOnce()
    expect(startAndroid).toHaveBeenCalledOnce()
    expect(prepareIos).toHaveBeenCalledOnce()
    expect(cancelIos).toHaveBeenCalledOnce()
    expect(refreshIos).toHaveBeenCalledOnce()
    expect(startIos).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('projects the durable enable flag onto the off / probe-failed views', () => {
    const host = readyScope(false)
    const controller = new PhoneSettingsCardController(host.scope)
    const face = controller.inject()
    expect(face.hooks.phoneSettingsCard.getSnapshot()).toEqual({
      enabled: false,
      writable: true,
      view: { kind: 'off' },
      runtime: { kind: 'missing', targetVersion: '1.0.5' },
      platforms: { android: { kind: 'deferred' }, ios: { kind: 'deferred' } },
    })
    face.setEnabled(true)
    expect(host.set).toHaveBeenCalledWith('enabled', true)
    controller.dispose()
  })

  it('republishes when the Host scope or the environment source moves', async () => {
    const host = readyScope(true)
    const views: PhoneEnvironmentView[] = [{ kind: 'probing', checks: [] }]
    const listeners = new Set<() => void>()
    const detect = async (): Promise<void> => {
      views[0] = { kind: 'android-wizard', platformToolsInstalled: false }
      for (const listener of [...listeners]) listener()
    }
    // A compliant ensureDetected runs the detection once per source.
    let detected = false
    const source: PhoneEnvironmentSource = {
      getView: () => views[0]!,
      redetect: detect,
      ensureDetected: () => {
        if (detected) return
        detected = true
        void detect()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const controller = new PhoneSettingsCardController(host.scope, source)
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({
        kind: 'android-wizard',
        platformToolsInstalled: false,
      })
    })
    views[0] = { kind: 'probing', checks: [] }
    face.redetect()
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({
        kind: 'android-wizard',
        platformToolsInstalled: false,
      })
    })
    controller.setSource(MISSING_PHONE_ENVIRONMENT_SOURCE)
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({
      kind: 'errors',
      errors: [PROBE_FAILED_ERROR],
    })
    host.publish({ value: { enabled: false } })
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({ kind: 'off' })
    const replacementListeners = new Set<() => void>()
    let replacement: PhoneEnvironmentView = { kind: 'errors', errors: [PROBE_FAILED_ERROR] }
    const replacementSource: PhoneEnvironmentSource = {
      getView: () => replacement,
      redetect: async () => {},
      subscribe: (listener) => {
        replacementListeners.add(listener)
        return () => { replacementListeners.delete(listener) }
      },
    }
    controller.setSource(replacementSource)
    replacement = { kind: 'ios-wizard' }
    for (const listener of [...replacementListeners]) listener()
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({ kind: 'off' })
    host.publish({ value: { enabled: true } })
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({ kind: 'ios-wizard' })
    controller.dispose()
    expect(replacementListeners.size).toBe(0)
  })

  it('copies a command and redetects on the recoverable next-action kinds', async () => {
    const host = readyScope(false)
    const redetect = vi.fn()
    const source: PhoneEnvironmentSource = {
      getView: () => ({ kind: 'errors', errors: [PROBE_FAILED_ERROR] }),
      redetect: async () => { redetect() },
      subscribe: () => () => {},
    }
    const writeText = vi.fn(() => Promise.resolve())
    const prepare = vi.fn(async () => {})
    const runtime: PhoneRuntimeSource = {
      getSnapshot: () => MISSING_PHONE_ENVIRONMENT,
      refresh: async () => {}, prepare, cancel: async () => {},
      prepareAndroid: async () => {}, cancelAndroid: async () => {}, refreshAndroid: async () => {}, startAndroid: async () => {},
      prepareIos: async () => {}, cancelIos: async () => {}, refreshIos: async () => {}, startIos: async () => {},
      ensureDetected: () => {}, subscribe: () => () => {}, dispose: vi.fn(),
    }
    const controller = new PhoneSettingsCardController(host.scope, source, { writeText }, runtime)
    const face = controller.inject()
    face.copyCommand('sdkmanager "platform-tools"')
    expect(writeText).toHaveBeenCalledWith('sdkmanager "platform-tools"')
    face.nextAction('adb-missing')
    face.nextAction('no-devices')
    face.nextAction('probe-failed')
    face.nextAction('mobilecli-missing')
    face.nextAction('wda-unbuilt')
    expect(redetect).toHaveBeenCalledTimes(3)
    expect(prepare).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('copies nothing when no clipboard face is composed', () => {
    const host = readyScope(true)
    const controller = new PhoneSettingsCardController(host.scope)
    controller.inject().copyCommand('sdkmanager "platform-tools"')
    void MISSING_PHONE_ENVIRONMENT_SOURCE.redetect()
    controller.dispose()
  })
})
