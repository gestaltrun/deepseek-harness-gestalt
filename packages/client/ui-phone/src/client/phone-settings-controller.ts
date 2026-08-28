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

/** What the phone settings card renders. */
export interface PhoneSettingsCardState {
  /** Durable enable flag (false keeps tools unregistered). */
  readonly enabled: boolean
  /** Whether the Host currently serves this namespace as writable. */
  readonly writable: boolean
  /** Environment view the card switches on. */
  readonly view: PhoneEnvironmentView
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
}

/**
 * Bridges the `ui-phone` scope and the environment source onto the card.
 */
export class PhoneSettingsCardController {
  private readonly store = createSnapshotStore<PhoneSettingsCardState>({
    enabled: false,
    writable: false,
    view: { kind: 'off' },
  })
  private readonly unsubscribeScope: () => void
  private unsubscribeSource: () => void
  private source: PhoneEnvironmentSource

  /**
   * @param scope - bound settings scope for the `ui-phone` namespace.
   * @param source - environment snapshot; defaults to the missing-service arm.
   * @param clipboard - optional clipboard writer used by copy buttons.
   */
  constructor(
    private readonly scope: SettingsScope<PhoneSettings>,
    source: PhoneEnvironmentSource = MISSING_PHONE_ENVIRONMENT_SOURCE,
    private readonly clipboard?: { writeText(text: string): Promise<void> },
  ) {
    this.source = source
    this.unsubscribeScope = scope.subscribe(() => { this.publish() })
    this.unsubscribeSource = source.subscribe(() => { this.publish() })
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
        if (kind === 'no-devices' || kind === 'adb-missing' || kind === 'probe-failed') {
          void this.source.redetect()
        }
      },
    }
  }

  private isEnabled(): boolean {
    return this.scope.getSnapshot().value?.enabled === true
  }

  private publish(): void {
    const snapshot = this.scope.getSnapshot()
    // An enabled card must not settle on the probe-failed arm while its
    // first detection is still in flight: kick it when it has not run.
    if (this.isEnabled()) this.source.ensureDetected?.()
    const enabled = snapshot.value?.enabled === true
    this.store.set({
      enabled,
      writable: snapshot.writable,
      view: resolvePhoneCardView(enabled, this.source),
    })
  }
}
