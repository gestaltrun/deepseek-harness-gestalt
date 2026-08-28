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

describe('PhoneSettingsCardController', () => {
  it('projects the durable enable flag onto the off / probe-failed views', () => {
    const host = readyScope(false)
    const controller = new PhoneSettingsCardController(host.scope)
    const face = controller.inject()
    expect(face.hooks.phoneSettingsCard.getSnapshot()).toEqual({
      enabled: false,
      writable: true,
      view: { kind: 'off' },
    })
    face.setEnabled(true)
    expect(host.set).toHaveBeenCalledWith('enabled', true)
    controller.dispose()
  })

  it('republishes when the Host scope or the environment source moves', () => {
    const host = readyScope(true)
    const views: PhoneEnvironmentView[] = [{ kind: 'probing', checks: [] }]
    const source: PhoneEnvironmentSource = {
      getView: () => views[0]!,
      redetect: () => { views[0] = { kind: 'android-wizard', platformToolsInstalled: false } },
    }
    const controller = new PhoneSettingsCardController(host.scope, source)
    const face = controller.inject()
    expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('probing')
    face.redetect()
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({
      kind: 'android-wizard',
      platformToolsInstalled: false,
    })
    controller.setSource(MISSING_PHONE_ENVIRONMENT_SOURCE)
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({
      kind: 'errors',
      errors: [PROBE_FAILED_ERROR],
    })
    host.publish({ value: { enabled: false } })
    expect(face.hooks.phoneSettingsCard.getSnapshot().view).toEqual({ kind: 'off' })
    controller.dispose()
  })

  it('copies a command and redetects on the recoverable next-action kinds', async () => {
    const host = readyScope(true)
    const redetect = vi.fn()
    const source: PhoneEnvironmentSource = {
      getView: () => ({ kind: 'errors', errors: [PROBE_FAILED_ERROR] }),
      redetect,
    }
    const writeText = vi.fn(() => Promise.resolve())
    const controller = new PhoneSettingsCardController(host.scope, source, { writeText })
    const face = controller.inject()
    face.copyCommand('sdkmanager "platform-tools"')
    expect(writeText).toHaveBeenCalledWith('sdkmanager "platform-tools"')
    face.nextAction('adb-missing')
    face.nextAction('no-devices')
    face.nextAction('probe-failed')
    face.nextAction('wda-unbuilt')
    expect(redetect).toHaveBeenCalledTimes(3)
    controller.dispose()
  })

  it('copies nothing when no clipboard face is composed', () => {
    const host = readyScope(true)
    const controller = new PhoneSettingsCardController(host.scope)
    controller.inject().copyCommand('sdkmanager "platform-tools"')
    MISSING_PHONE_ENVIRONMENT_SOURCE.redetect()
    controller.dispose()
  })
})
