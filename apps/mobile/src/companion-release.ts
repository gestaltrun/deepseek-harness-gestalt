/** Controlled Mobile Companion release validation. Distribution stays gated. */

export const COMPANION_RELEASE_FLOWS = [
  'github-login',
  'camera-pairing',
  'link-pairing',
  'desktop-navigation',
  'workspace-create',
  'ungrouped-create',
  'prompt',
  'cancel',
  'approval',
  'question',
  'attachment',
  'cache',
] as const

export const COMPANION_RELEASE_PLATFORMS = ['ios', 'android'] as const

export const COMPANION_RELEASE_DEVICE_CHECKS = [
  'protected-key-storage',
  'encrypted-cache',
  'file-selection',
  'foreground-lifecycle',
] as const

type CompanionReleaseFlow = (typeof COMPANION_RELEASE_FLOWS)[number]
type CompanionReleasePlatform = (typeof COMPANION_RELEASE_PLATFORMS)[number]
type CompanionReleaseDeviceCheck = (typeof COMPANION_RELEASE_DEVICE_CHECKS)[number]

export interface CompanionReleaseEvidence {
  /** Completed real-device product flows. */
  flows: ReadonlySet<CompanionReleaseFlow>
  /** Per-platform device checks. */
  devices: ReadonlySet<`${CompanionReleasePlatform}:${CompanionReleaseDeviceCheck}`>
  /** Upgrade preserved Personal Pairing keys. */
  upgradePreservedKeys: boolean
  /** Phone-size assembled UI acceptance. */
  uiAcceptance: boolean
  /** Assembled failure-path acceptance. */
  failureAcceptance: boolean
  /** Independent Noise security review completed. */
  noiseReview: boolean
}

/**
 * Whether assembled validation is complete. Does not produce a store build.
 * @param evidence - collected device and assembled results.
 */
export function companionReleaseReady(evidence: CompanionReleaseEvidence): boolean {
  if (!evidence.upgradePreservedKeys || !evidence.uiAcceptance || !evidence.failureAcceptance || !evidence.noiseReview) {
    return false
  }
  for (const flow of COMPANION_RELEASE_FLOWS) {
    if (!evidence.flows.has(flow)) return false
  }
  for (const platform of COMPANION_RELEASE_PLATFORMS) {
    for (const check of COMPANION_RELEASE_DEVICE_CHECKS) {
      if (!evidence.devices.has(`${platform}:${check}`)) return false
    }
  }
  return true
}

/**
 * Produce a TestFlight or signed APK only after explicit per-release approval.
 * @param evidence - assembled validation.
 * @param approval - explicit human approval for this release.
 */
export function authorizeCompanionDistribution(
  evidence: CompanionReleaseEvidence,
  approval: { testFlight?: boolean; androidApk?: boolean },
): { testFlight: boolean; androidApk: boolean } {
  if (!companionReleaseReady(evidence)) throw new Error('Companion release validation is incomplete')
  return {
    testFlight: approval.testFlight === true,
    androidApk: approval.androidApk === true,
  }
}
