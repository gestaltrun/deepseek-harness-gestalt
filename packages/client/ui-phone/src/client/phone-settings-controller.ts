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
  MISSING_PHONE_RUNTIME, type PhoneManagedRuntimeView, type PhoneRuntimeSource,
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
  /** Start trusted managed mobilecli preparation. */
  prepareRuntime: () => void
  /** Cancel the active preparation operation. */
  cancelRuntime: () => void
  /** Refresh runtime discovery. */
  refreshRuntime: () => void
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
  })
  private readonly unsubscribeScope: () => void
  private unsubscribeSource: () => void
  private source: PhoneEnvironmentSource
  private readonly unsubscribeRuntime: () => void

  /**
   * @param scope - bound settings scope for the `ui-phone` namespace.
   * @param source - environment snapshot; defaults to the missing-service arm.
   * @param clipboard - optional clipboard writer used by copy buttons.
   */
  constructor(
    private readonly scope: SettingsScope<PhoneSettings>,
    source: PhoneEnvironmentSource = MISSING_PHONE_ENVIRONMENT_SOURCE,
    private readonly clipboard?: { writeText(text: string): Promise<void> },
    private readonly runtime?: PhoneRuntimeSource,
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
    this.unsubscribeRuntime()
    this.source = source
    this.unsubscribeSource = source.subscribe(() => { this.publish() })
    this.publish()
  }

  /** Stop following the settings scope and the environment source. */
  dispose(): void {
    this.unsubscribeScope()
    this.unsubscribeSource()
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
        if (kind === 'no-devices' || kind === 'adb-missing' || kind === 'probe-failed' || kind === 'mobilecli-missing') {
          void this.source.redetect()
        }
      },
      prepareRuntime: () => { void this.runtime?.prepare().catch(() => {}) },
      cancelRuntime: () => { void this.runtime?.cancel().catch(() => {}) },
      refreshRuntime: () => { void this.runtime?.refresh().catch(() => {}) },
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
      this.store.set({
        enabled,
        writable: snapshot.writable,
        view: resolvePhoneCardView(enabled, this.source),
        runtime: this.runtime?.getRuntime() ?? MISSING_PHONE_RUNTIME,
      })
    } finally {
      this.publishing = false
    }
  }
}
