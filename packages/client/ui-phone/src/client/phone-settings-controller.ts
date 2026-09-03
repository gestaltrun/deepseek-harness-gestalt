/**
 * Phone settings card controller: projects the durable `ui-phone` scope and
 * the injected environment source into one snapshot the slot renderer binds.
 */
import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { PhoneSettings } from '../phone-settings.ts'
import {
  MISSING_PHONE_ENVIRONMENT_SOURCE, resolvePhoneCardView,
  type PhoneEnvironmentSource, type PhoneEnvironmentView,
} from './phone-environment.ts'
import {
  MISSING_PHONE_ENVIRONMENT, MISSING_PHONE_RUNTIME, type PhoneManagedRuntimeView,
  type PhoneAndroidView, type PhoneIosView, type PhoneRuntimeSource,
} from './phone-runtime-source.ts'

/** What the phone settings card renders. */
export interface PhoneSettingsCardState {
  /** Durable enable flag (false keeps tools unregistered). */
  readonly enabled: boolean
  /** Whether the Host currently serves this namespace as writable. */
  readonly writable: boolean
  /** Environment view the card switches on. */
  readonly view: PhoneEnvironmentView
  /** Shared Host-managed mobilecli runtime state. */
  readonly runtime: PhoneManagedRuntimeView
  /** Host platform capabilities, including unsupported reasons. */
  readonly platforms: { readonly android: PhoneAndroidView; readonly ios: PhoneIosView }
}

/** The registration-side face the card's slot entry injects. */
export interface PhoneSettingsCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as usePhoneSettingsCard. */
    phoneSettingsCard: SnapshotStore<PhoneSettingsCardState>
  }
  /** Persist the enable switch. */
  setEnabled: (enabled: boolean) => void
  /** Re-run detection after a wizard step. */
  redetect: () => void
  /** Copy one command-level install line. */
  copyCommand: (command: string) => void
  /** Fire the unified next-action verb for one error row. */
  nextAction: (kind: string) => void
  /** Open one online device in the singleton Phone tab. */
  openDevice: (deviceId: string) => void
  /** Start trusted managed mobilecli preparation. */
  prepareRuntime: () => void
  /** Cancel the active preparation operation. */
  cancelRuntime: () => void
  /** Refresh runtime discovery. */
  refreshRuntime: () => void
  /** Start Android SDK, image, AVD, and emulator preparation after explicit license consent. */
  prepareAndroid: () => void
  /** Cancel Android download, installation, or boot. */
  cancelAndroid: () => void
  /** Re-detect Android SDK and AVD state. */
  refreshAndroid: () => void
  /** Start the prepared default Android emulator. */
  startAndroid: () => void
  /** Prepare the Xcode iOS Runtime and product Simulator. */
  prepareIos: () => void
  /** Cancel iOS Runtime download, creation, or boot. */
  cancelIos: () => void
  /** Re-detect Xcode, iOS Runtime, and Simulator state. */
  refreshIos: () => void
  /** Start the prepared product iOS Simulator. */
  startIos: () => void
}

/**
 * Bridges the `ui-phone` scope and the environment source onto the card.
 */
export class PhoneSettingsCardController {
  private readonly store = createSnapshotStore<PhoneSettingsCardState>({
    enabled: false,
    writable: false,
    view: { kind: 'off' },
    runtime: MISSING_PHONE_RUNTIME,
    platforms: MISSING_PHONE_ENVIRONMENT.platforms,
  })
  private readonly unsubscribeScope: () => void
  private unsubscribeSource: () => void
  private source: PhoneEnvironmentSource
  private readonly unsubscribeRuntime: () => void

  /**
   * @param scope - bound settings scope for the `ui-phone` namespace.
   * @param source - environment snapshot; defaults to the missing-service arm.
   * @param clipboard - optional clipboard writer used by copy buttons.
   * @param runtime - owned Host source released with this controller.
   * @param openDevice - browser-owned projection from Settings to the Phone tab.
   */
  constructor(
    private readonly scope: SettingsScope<PhoneSettings>,
    source: PhoneEnvironmentSource = MISSING_PHONE_ENVIRONMENT_SOURCE,
    private readonly clipboard?: { writeText(text: string): Promise<void> },
    private readonly runtime?: PhoneRuntimeSource,
    private readonly openDevice: (deviceId: string) => void = () => {},
  ) {
    this.source = source
    this.unsubscribeScope = scope.subscribe(() => { this.publish() })
    this.unsubscribeSource = source.subscribe(() => { this.publish() })
    this.unsubscribeRuntime = runtime?.subscribe(() => { this.publish() }) ?? (() => {})
    this.publish()
  }

  /**
   * Replace the environment source and republish.
   * @param source - Environment snapshot the card should now follow.
   */
  setSource(source: PhoneEnvironmentSource): void {
    this.unsubscribeSource()
    this.source = source
    this.unsubscribeSource = source.subscribe(() => { this.publish() })
    this.publish()
  }

  /** Stop following the settings scope and the environment source. */
  dispose(): void {
    this.unsubscribeScope()
    this.unsubscribeSource()
    this.unsubscribeRuntime()
    this.runtime?.dispose()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its callbacks.
   */
  inject(): PhoneSettingsCardFace {
    return {
      hooks: { phoneSettingsCard: this.store },
      setEnabled: (enabled) => { void this.scope.set('enabled', enabled) },
      redetect: () => { void this.source.redetect() },
      copyCommand: (command) => { void this.clipboard?.writeText(command) },
      nextAction: (kind) => {
        if (kind === 'mobilecli-missing') {
          void this.runtime?.prepare().catch(() => {})
        } else if (kind === 'no-devices' || kind === 'adb-missing' || kind === 'probe-failed') {
          void this.source.redetect()
        }
      },
      openDevice: this.openDevice,
      prepareRuntime: () => { void this.runtime?.prepare().catch(() => {}) },
      cancelRuntime: () => { void this.runtime?.cancel().catch(() => {}) },
      refreshRuntime: () => { void this.runtime?.refresh().catch(() => {}) },
      prepareAndroid: () => { void this.runtime?.prepareAndroid().catch(() => {}) },
      cancelAndroid: () => { void this.runtime?.cancelAndroid().catch(() => {}) },
      refreshAndroid: () => { void this.runtime?.refreshAndroid().catch(() => {}) },
      startAndroid: () => { void this.runtime?.startAndroid().catch(() => {}) },
      prepareIos: () => { void this.runtime?.prepareIos().catch(() => {}) },
      cancelIos: () => { void this.runtime?.cancelIos().catch(() => {}) },
      refreshIos: () => { void this.runtime?.refreshIos().catch(() => {}) },
      startIos: () => { void this.runtime?.startIos().catch(() => {}) },
    }
  }

  private isEnabled(): boolean {
    return this.scope.getSnapshot().value?.enabled === true
  }

  private publishing = false

  private publish(): void {
    // Subscribe callbacks (a detection completing mid-kick) re-enter here
    // synchronously; the re-entrant call must not kick the source again or
    // the publish → ensureDetected → notify → publish wave never ends (P17).
    // The outer wave's store.set below already reads the updated view.
    if (this.publishing) return
    this.publishing = true
    try {
      const snapshot = this.scope.getSnapshot()
      // An enabled card must not settle on the probe-failed arm while its
      // first detection is still in flight: kick it when it has not run.
      if (this.isEnabled()) this.source.ensureDetected?.()
      this.runtime?.ensureDetected()
      const enabled = snapshot.value?.enabled === true
      const environment = this.runtime?.getSnapshot() ?? MISSING_PHONE_ENVIRONMENT
      this.store.set({
        enabled,
        writable: snapshot.writable,
        view: resolvePhoneCardView(enabled, this.source),
        runtime: environment.runtime,
        platforms: environment.platforms,
      })
    } finally {
      this.publishing = false
    }
  }
}
