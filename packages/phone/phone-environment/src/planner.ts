import { MOBILECLI_MANAGED_VERSION, selectMobilecliReleaseAsset } from './manifest.ts'
import type { PhoneEnvironmentSnapshot, PhoneRuntimeCandidate } from './types.ts'

/** Candidate paths in their fixed operational precedence order. */
export interface PhoneRuntimeCandidates {
  /** Explicit deployment override. */
  readonly override?: string
  /** Gestalt-managed current pointer. */
  readonly managed?: string
  /** Executable discovered from the host installation. */
  readonly system?: string
}

/**
 * Select the first non-empty executable path in the fixed override-managed-system order.
 * @param candidates - discovered paths by source.
 * @returns the winning candidate, or undefined when no source is usable.
 */
export function selectPhoneRuntimeCandidate(candidates: PhoneRuntimeCandidates): PhoneRuntimeCandidate | undefined {
  const ordered = [
    ['override', candidates.override],
    ['managed', candidates.managed],
    ['system', candidates.system],
  ] as const
  for (const [source, value] of ordered) {
    const executablePath = value?.trim()
    if (executablePath !== undefined && executablePath.length > 0) return Object.freeze({ source, executablePath })
  }
  return undefined
}

/**
 * Create the first full environment snapshot before host discovery begins.
 * @param platform - Node platform value.
 * @param architecture - Node architecture value.
 * @param enabled - durable user gate.
 * @returns an immutable missing-runtime snapshot with truthful platform capability.
 */
export function initialPhoneEnvironmentSnapshot(
  platform: string,
  architecture: string,
  enabled: boolean,
): PhoneEnvironmentSnapshot {
  let assetBytes: number | undefined
  try {
    assetBytes = selectMobilecliReleaseAsset(platform, architecture).bytes
  } catch {
    // Unsupported host tuples stay visible through a failed prepare later;
    // the initial snapshot has no download size to promise.
  }
  return Object.freeze({
    revision: 0,
    enabled,
    runtime: Object.freeze({
      kind: 'missing',
      targetVersion: MOBILECLI_MANAGED_VERSION,
      ...(assetBytes === undefined ? {} : { assetBytes }),
    }),
    platforms: Object.freeze({
      android: Object.freeze({ kind: 'deferred' }),
      ios: platform === 'darwin'
        ? Object.freeze({ kind: 'deferred' })
        : Object.freeze({
          kind: 'unsupported',
          reason: 'iOS Simulator and physical iPhone control require macOS with a complete Xcode installation.',
        }),
    }),
  })
}
