/** Classify and serialize CI gate evidence without depending on GitHub Actions. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { GateResult, Mode } from './run-gates.ts'

const CI_EVIDENCE_FORMAT_VERSION = 1

/** Closed failure categories emitted by CI evidence. */
export type CiFailureClassification =
  | 'product-regression'
  | 'coverage'
  | 'snapshot'
  | 'generated-drift'
  | 'workflow-policy'
  | 'runner-contamination'
  | 'transient-infrastructure'

interface CiGateEvidence {
  id: string
  label: string
  status: GateResult['status']
  blocking: boolean
  durationMs: number
  classification: CiFailureClassification | null
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  error: string | null
}

/** Serialized evidence for one run-gates aggregate. */
export interface CiGateReport {
  formatVersion: typeof CI_EVIDENCE_FORMAT_VERSION
  mode: Mode
  status: 'passed' | 'failed'
  startedAt: string
  completedAt: string
  durationMs: number
  firstFailure: { gateId: string; classification: CiFailureClassification } | null
  gates: CiGateEvidence[]
  artifactRefs: string[]
  caches: CiCacheEvidence[]
}

/** One cache restore outcome recorded beside gate evidence. */
export interface CiCacheEvidence {
  id: string
  primaryKey: string
  matchedKey: string
  exactHit: boolean
}

/** Parse structured cache evidence supplied by the workflow boundary. */
export function parseCiCacheEvidence(raw: string | undefined): CiCacheEvidence[] {
  if (raw === undefined || raw === '') return []
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value)) throw new Error('CI cache evidence must be an array')
  return value.map((entry, index) => {
    if (!isRecord(entry)
      || typeof entry.id !== 'string'
      || entry.id === ''
      || typeof entry.primaryKey !== 'string'
      || typeof entry.matchedKey !== 'string'
      || typeof entry.exactHit !== 'boolean') {
      throw new Error(`CI cache evidence entry ${String(index)} is invalid`)
    }
    return {
      id: entry.id,
      primaryKey: entry.primaryKey,
      matchedKey: entry.matchedKey,
      exactHit: entry.exactHit,
    }
  })
}

const GENERATED_GATE_IDS = new Set([
  'agent-note-classification',
  'agent-note-format',
  'archived-agent-notes',
  'client-catalog',
  'config-catalog',
  'cordis-api',
  'cordis-catalog',
  'doc-graphs',
  'module-graph',
  'persistence-catalog',
  'scoped-events',
  'tool-catalog',
  'translation-pairing',
])

const WORKFLOW_POLICY_GATE_IDS = new Set([
  'constraints',
  'issue-management',
  'skill-invocation-metadata',
])

const TRANSIENT_INFRASTRUCTURE_PATTERNS = [
  /client\.timeout exceeded while awaiting headers/iu,
  /connection reset by peer/iu,
  /econnreset/iu,
  /etimedout/iu,
  /gyp ERR! stack AssertionError[\s\S]*assert\(!this\.paused\)[\s\S]*undici[\\/]+lib[\\/]+dispatcher[\\/]+client-h1\.js/iu,
  /tls handshake timeout/iu,
  /temporary failure in name resolution/iu,
]

const RUNNER_CONTAMINATION_PATTERNS = [
  /enospc/iu,
  /no space left on device/iu,
  /text file busy/iu,
  /resource temporarily unavailable/iu,
]

/**
 * Match only diagnostics that identify a retryable infrastructure transport failure.
 * @param diagnostics - Complete command output from one failed attempt.
 * @returns Whether one bounded retry is permitted.
 */
export function isTransientInfrastructureFailure(diagnostics: string): boolean {
  return TRANSIENT_INFRASTRUCTURE_PATTERNS.some(pattern => pattern.test(diagnostics))
}

/**
 * Classify a failed gate from its owned id and exact process diagnostics.
 * @param result - Failed or skipped gate outcome.
 * @returns Stable failure category used by reports and retry policy.
 */
export function classifyGateFailure(result: GateResult): CiFailureClassification {
  const diagnostics = [
    result.error ?? '',
    ...result.output.map(chunk => chunk.text),
  ].join('\n')
  if (result.gate.failureDomain === 'infrastructure' && isTransientInfrastructureFailure(diagnostics)) {
    return 'transient-infrastructure'
  }
  if (RUNNER_CONTAMINATION_PATTERNS.some(pattern => pattern.test(diagnostics)) || result.signalCode !== null) {
    return 'runner-contamination'
  }
  if (result.gate.id === 'coverage' || result.gate.id === 'coverage-exempt-heavy') return 'coverage'
  if (result.gate.id === 'snapshot' || result.gate.id === 'web-snapshot') return 'snapshot'
  if (GENERATED_GATE_IDS.has(result.gate.id)) return 'generated-drift'
  if (WORKFLOW_POLICY_GATE_IDS.has(result.gate.id)) return 'workflow-policy'
  return 'product-regression'
}

/**
 * Build the machine-readable report for one gate-runner process.
 * @param mode - Aggregate selected by the caller.
 * @param results - Results in aggregate declaration order.
 * @param settledResults - Results in actual completion order.
 * @param startedAt - Process start time.
 * @param completedAt - Process completion time.
 * @param artifactRefs - Stable artifact names related to this lane.
 * @returns Versioned gate evidence.
 */
export function buildGateReport(
  mode: Mode,
  results: readonly GateResult[],
  settledResults: readonly GateResult[],
  startedAt: Date,
  completedAt: Date,
  artifactRefs: readonly string[],
  caches: readonly CiCacheEvidence[] = [],
): CiGateReport {
  const blockingFailure = settledResults.find(result =>
    result.gate.allowFailure !== true && (result.status === 'failed' || result.status === 'skipped'))
  const status = results.some(result =>
    result.gate.allowFailure !== true && (result.status === 'failed' || result.status === 'skipped'))
    ? 'failed'
    : 'passed'
  return {
    formatVersion: CI_EVIDENCE_FORMAT_VERSION,
    mode,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    firstFailure: blockingFailure === undefined
      ? null
      : {
        gateId: blockingFailure.gate.id,
        classification: classifyGateFailure(blockingFailure),
      },
    gates: results.map(result => ({
      id: result.gate.id,
      label: result.gate.label,
      status: result.status,
      blocking: result.gate.allowFailure !== true,
      durationMs: result.durationMs,
      classification: result.status === 'passed' ? null : classifyGateFailure(result),
      exitCode: result.exitCode,
      signalCode: result.signalCode,
      error: result.error ?? null,
    })),
    artifactRefs: [...new Set(artifactRefs)].sort(),
    caches: [...caches],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Write a CI report after creating only its owned parent directory.
 * @param path - Destination supplied by the CI workflow.
 * @param report - Complete report to serialize.
 */
export function writeGateReport(path: string, report: CiGateReport): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
}
