/** Controlled Mobile Companion release validation. Distribution stays gated. */

export const COMPANION_RELEASE_FLOWS = [
  'github-login',
  'account',
  'camera-pairing',
  'link-pairing',
  'desktop-navigation',
  'search',
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
  /** Completed operated product flows on approved native devices, Emulators, or Simulators. */
  flows: ReadonlySet<CompanionReleaseFlow>
  /** Per-platform device checks. */
  devices: ReadonlySet<`${CompanionReleasePlatform}:${CompanionReleaseDeviceCheck}`>
  /** Upgrade preserved Personal Pairing keys. */
  upgradePreservedKeys: boolean
  /** Phone-size assembled UI acceptance. */
  uiAcceptance: boolean
  /** Assembled failure-path acceptance. */
  failureAcceptance: boolean
}

/** Candidate-bound immutable acceptance record consumed before Mobile signing. */
export interface CompanionReleaseAttestation {
  formatVersion: 1
  repository: string
  sourceRunId: number
  sourceEvent: 'workflow_dispatch'
  acceptanceVerdict: 'success'
  candidateSha: string
  tree: string
  flows: readonly CompanionReleaseFlow[]
  devices: readonly `${CompanionReleasePlatform}:${CompanionReleaseDeviceCheck}`[]
  upgradePreservedKeys: true
  uiAcceptance: true
  failureAcceptance: true
  transportRiskAccepted: true
}

/** Identity expected by the signing workflow for one acceptance artifact. */
export interface CompanionReleaseAttestationIdentity {
  repository: string
  sourceRunId: number
  candidateSha: string
  tree: string
}

/**
 * Whether assembled validation is complete. Does not produce a store build.
 * @param evidence - collected device and assembled results.
 */
export function companionReleaseReady(evidence: CompanionReleaseEvidence): boolean {
  if (!evidence.upgradePreservedKeys || !evidence.uiAcceptance || !evidence.failureAcceptance) {
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
  approval: { testFlight?: boolean; androidApk?: boolean; transportRiskAccepted?: boolean },
): { testFlight: boolean; androidApk: boolean } {
  if (!companionReleaseReady(evidence)) throw new Error('Companion release validation is incomplete')
  if ((approval.testFlight === true || approval.androidApk === true) && approval.transportRiskAccepted !== true) {
    throw new Error('Companion transport risk has not been explicitly accepted')
  }
  return {
    testFlight: approval.testFlight === true,
    androidApk: approval.androidApk === true,
  }
}

/**
 * Validate operator evidence and bind it to one immutable acceptance run and Git candidate.
 * @param value - untrusted operator evidence JSON.
 * @param identity - current repository, run, commit, and tree identity.
 * @returns complete acceptance attestation suitable for an Actions artifact.
 */
export function createCompanionReleaseAttestation(
  value: unknown,
  identity: CompanionReleaseAttestationIdentity,
): CompanionReleaseAttestation {
  assertAttestationIdentity(identity)
  if (!isRecord(value) || value.transportRiskAccepted !== true) {
    throw new Error('Companion transport risk has not been explicitly accepted')
  }
  const evidence = parseOperatorEvidence(value)
  authorizeCompanionDistribution(evidence, {
    testFlight: true,
    androidApk: true,
    transportRiskAccepted: true,
  })
  return {
    formatVersion: 1,
    ...identity,
    sourceEvent: 'workflow_dispatch',
    acceptanceVerdict: 'success',
    flows: [...evidence.flows],
    devices: [...evidence.devices],
    upgradePreservedKeys: true,
    uiAcceptance: true,
    failureAcceptance: true,
    transportRiskAccepted: true,
  }
}

/**
 * Verify one downloaded artifact against the requested release and run authorization.
 * @param value - untrusted acceptance artifact JSON.
 * @param expected - exact repository, run, commit, and tree identity.
 * @param approval - signing operations and dispatch-scoped transport approval.
 * @returns authorized distribution operations.
 */
export function verifyCompanionReleaseAttestation(
  value: unknown,
  expected: CompanionReleaseAttestationIdentity,
  approval: { testFlight: boolean; androidApk: boolean; transportRiskAccepted: boolean },
): { testFlight: boolean; androidApk: boolean } {
  assertAttestationIdentity(expected)
  if (!isRecord(value)
    || value.formatVersion !== 1
    || value.sourceEvent !== 'workflow_dispatch'
    || value.acceptanceVerdict !== 'success'
    || value.upgradePreservedKeys !== true
    || value.uiAcceptance !== true
    || value.failureAcceptance !== true
    || value.transportRiskAccepted !== true) {
    throw new Error('Companion release attestation is invalid')
  }
  for (const field of ['repository', 'sourceRunId', 'candidateSha', 'tree'] as const) {
    if (value[field] !== expected[field]) throw new Error(`Companion release attestation ${field} does not match`)
  }
  const evidence = parseOperatorEvidence(value)
  return authorizeCompanionDistribution(evidence, approval)
}

function parseOperatorEvidence(value: unknown): CompanionReleaseEvidence {
  if (!isRecord(value)) throw new Error('Companion release evidence must be an object')
  return {
    flows: exactEvidenceSet(value.flows, COMPANION_RELEASE_FLOWS, 'flow'),
    devices: exactEvidenceSet(
      value.devices,
      COMPANION_RELEASE_PLATFORMS.flatMap(platform =>
        COMPANION_RELEASE_DEVICE_CHECKS.map(check => `${platform}:${check}` as const)),
      'device check',
    ),
    upgradePreservedKeys: requiredTrue(value.upgradePreservedKeys, 'upgrade preservation'),
    uiAcceptance: requiredTrue(value.uiAcceptance, 'UI acceptance'),
    failureAcceptance: requiredTrue(value.failureAcceptance, 'failure acceptance'),
  }
}

function exactEvidenceSet<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  name: string,
): ReadonlySet<Value> {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Companion release ${name} evidence must be a string array`)
  }
  const unique = new Set(value)
  if (unique.size !== value.length) throw new Error(`Companion release ${name} evidence contains duplicates`)
  const allowedSet = new Set<string>(allowed)
  const unknown = value.find(item => !allowedSet.has(item as string))
  if (unknown !== undefined) throw new Error(`Companion release ${name} evidence contains unknown value ${String(unknown)}`)
  return unique as Set<Value>
}

function requiredTrue(value: unknown, name: string): true {
  if (value !== true) throw new Error(`Companion release ${name} is incomplete`)
  return true
}

function assertAttestationIdentity(identity: CompanionReleaseAttestationIdentity): void {
  if (identity.repository === '') throw new Error('Companion release repository is required')
  if (!Number.isSafeInteger(identity.sourceRunId) || identity.sourceRunId < 1) {
    throw new Error('Companion release source run id is invalid')
  }
  if (!/^[0-9a-f]{40}$/u.test(identity.candidateSha) || !/^[0-9a-f]{40}$/u.test(identity.tree)) {
    throw new Error('Companion release Git identity is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
