/** Host-owned phone toolchain state and trusted mobilecli preparation. @module @deepseek-ai/dsh-phone-environment */

import { Context, Service } from '@deepseek-ai/cordis'
import { initialPhoneEnvironmentSnapshot } from './planner.ts'
import type { PhoneEnvironmentSnapshot } from './types.ts'

export { MOBILECLI_MANAGED_VERSION, MOBILECLI_RELEASE_ASSETS, selectMobilecliReleaseAsset } from './manifest.ts'
export { initialPhoneEnvironmentSnapshot, selectPhoneRuntimeCandidate } from './planner.ts'
export type { PhoneRuntimeCandidates } from './planner.ts'
export type {
  MobilecliArchitecture,
  MobilecliPlatform,
  MobilecliReleaseAsset,
  PhoneEnvironmentSnapshot,
  PhonePlatformState,
  PhoneRuntimeCandidate,
  PhoneRuntimeSource,
  PhoneRuntimeState,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned phone toolchain state and preparation operations. */
    phoneEnvironment: PhoneEnvironment
  }
}

/** Host phone-environment Service with stable snapshot identity across runtime generations. */
export class PhoneEnvironment extends Service {
  private current: PhoneEnvironmentSnapshot
  private readonly listeners = new Set<(snapshot: PhoneEnvironmentSnapshot) => void>()

  /**
   * Publish the initial host/platform facts and own subscriber cleanup.
   * @param ctx - owning Cordis context.
   */
  constructor(ctx: Context) {
    super(ctx, 'phoneEnvironment')
    this.current = initialPhoneEnvironmentSnapshot(process.platform, process.arch, false)
    ctx.effect(() => () => { this.listeners.clear() }, 'phone environment subscriber cleanup')
  }

  /** @returns the current immutable full snapshot. */
  snapshot(): PhoneEnvironmentSnapshot {
    return this.current
  }

  /**
   * Project the durable settings gate without replacing this Service identity.
   * @param enabled - current `ui-phone.enabled` value.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.current.enabled) return
    this.current = Object.freeze({ ...this.current, revision: this.current.revision + 1, enabled })
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }

  /**
   * Subscribe to committed full-snapshot replacements.
   * @param listener - callback receiving the new immutable snapshot.
   * @returns the disposer.
   */
  onChanged(listener: (snapshot: PhoneEnvironmentSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export default PhoneEnvironment
