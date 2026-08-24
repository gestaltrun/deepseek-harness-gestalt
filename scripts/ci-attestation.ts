/** Create and verify Merge Queue evidence identities and attestations. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const FORMAT_VERSION = 1
const WORKFLOW_PLANNER_FILES = [
  '.github/workflows/ci.yml',
  'scripts/ci-plan.ts',
  'scripts/ci-risk-catalog.json',
] as const
const TOOLCHAIN_FILES = ['package.json', 'pnpm-workspace.yaml'] as const
const GATE_INVENTORY_FILES = [
  'scripts/run-gates.ts',
  'vitest.config.ts',
  'vitest.snapshot.config.ts',
  'vitest.web.config.ts',
] as const

/** Exact environment identity required to reuse one successful candidate proof. */
export interface CiEvidenceIdentity {
  formatVersion: typeof FORMAT_VERSION
  tree: string
  lockfileDigest: string
  workflowPlannerDigest: string
  toolchainDigest: string
  gateInventoryDigest: string
  evidenceKey: string
}

/** Auditable completion record published only after the candidate verdict succeeds. */
export interface CiCandidateAttestation extends CiEvidenceIdentity {
  complete: true
  repository: string
  sourceRunId: number
  sourceEvent: 'merge_group'
  candidateVerdict: 'success'
}

/** Master-side decision and its explicit fallback reason. */
export interface CiEvidenceReuseDecision {
  formatVersion: typeof FORMAT_VERSION
  reused: boolean
  reason: string
  sourceRunId: number | null
  identity: CiEvidenceIdentity
}

/** Compute the proof identity from the checked-out Git tree and owned inputs. */
export function createCiEvidenceIdentity(root: string): CiEvidenceIdentity {
  const identityWithoutKey: Omit<CiEvidenceIdentity, 'evidenceKey'> = {
    formatVersion: FORMAT_VERSION,
    tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    lockfileDigest: digestFiles(root, ['pnpm-lock.yaml']),
    workflowPlannerDigest: digestFiles(root, WORKFLOW_PLANNER_FILES),
    toolchainDigest: digestFiles(root, TOOLCHAIN_FILES),
    gateInventoryDigest: digestFiles(root, GATE_INVENTORY_FILES),
  }
  return {
    ...identityWithoutKey,
    evidenceKey: sha256(JSON.stringify(identityWithoutKey)),
  }
}

/** Complete an identity after the fail-closed candidate verdict has succeeded. */
export function completeCiCandidateAttestation(
  identity: CiEvidenceIdentity,
  repository: string,
  sourceRunId: number,
): CiCandidateAttestation {
  if (repository === '') throw new Error('ci-attestation: repository is required')
  if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) {
    throw new Error(`ci-attestation: invalid source run id ${String(sourceRunId)}`)
  }
  return {
    ...identity,
    complete: true,
    repository,
    sourceRunId,
    sourceEvent: 'merge_group',
    candidateVerdict: 'success',
  }
}

/** Decide whether one parsed attestation exactly proves the current tree and environment. */
export function decideCiEvidenceReuse(
  identity: CiEvidenceIdentity,
  candidate: unknown,
  expectedRepository: string,
  expectedRunId: number,
): CiEvidenceReuseDecision {
  const parsed = parseCiCandidateAttestation(candidate)
  if (parsed === null) return fallback(identity, 'attestation-invalid')
  if (parsed.repository !== expectedRepository) return fallback(identity, 'repository-mismatch')
  if (parsed.sourceRunId !== expectedRunId) return fallback(identity, 'run-id-mismatch')
  const mismatched = evidenceFields().find(field => parsed[field] !== identity[field])
  if (mismatched !== undefined) return fallback(identity, `${mismatched}-mismatch`)
  return {
    formatVersion: FORMAT_VERSION,
    reused: true,
    reason: 'exact-candidate-proof',
    sourceRunId: parsed.sourceRunId,
    identity,
  }
}

/** Parse an untrusted artifact payload without accepting partial proof. */
export function parseCiCandidateAttestation(value: unknown): CiCandidateAttestation | null {
  if (!isRecord(value)
    || value.formatVersion !== FORMAT_VERSION
    || value.complete !== true
    || typeof value.repository !== 'string'
    || !Number.isSafeInteger(value.sourceRunId)
    || value.sourceEvent !== 'merge_group'
    || value.candidateVerdict !== 'success'
    || !evidenceFields().every(field => typeof value[field] === 'string')) return null
  return value as unknown as CiCandidateAttestation
}

function evidenceFields(): Array<keyof CiEvidenceIdentity> {
  return [
    'tree',
    'lockfileDigest',
    'workflowPlannerDigest',
    'toolchainDigest',
    'gateInventoryDigest',
    'evidenceKey',
  ]
}

function fallback(identity: CiEvidenceIdentity, reason: string): CiEvidenceReuseDecision {
  return { formatVersion: FORMAT_VERSION, reused: false, reason, sourceRunId: null, identity }
}

function digestFiles(root: string, paths: readonly string[]): string {
  const digest = createHash('sha256')
  for (const path of [...paths].sort()) {
    digest.update(path)
    digest.update('\0')
    digest.update(readFileSync(resolve(root, path)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface GitHubArtifact {
  id: number
  expired: boolean
  workflowRunId: number
}

function resolveRemoteProof(repository: string, identity: CiEvidenceIdentity): CiEvidenceReuseDecision {
  const artifactName = `ci-candidate-attestation-${identity.tree}`
  try {
    const response = JSON.parse(execFileSync('gh', [
      'api',
      `/repos/${repository}/actions/artifacts?name=${artifactName}&per_page=100`,
    ], { encoding: 'utf8' })) as unknown
    const artifacts = parseArtifacts(response)
    if (artifacts.length === 0) return fallback(identity, 'attestation-missing')
    for (const artifact of artifacts) {
      if (artifact.expired) continue
      const run = JSON.parse(execFileSync('gh', [
        'api',
        `/repos/${repository}/actions/runs/${String(artifact.workflowRunId)}`,
      ], { encoding: 'utf8' })) as unknown
      if (!isMergeGroupRun(run)) continue
      const jobs = JSON.parse(execFileSync('gh', [
        'api',
        `/repos/${repository}/actions/runs/${String(artifact.workflowRunId)}/jobs?per_page=100`,
      ], { encoding: 'utf8' })) as unknown
      if (!hasSuccessfulCandidateVerdict(jobs)) continue
      const destination = mkdtempSync(join(tmpdir(), 'dsh-ci-attestation-'))
      try {
        execFileSync('gh', [
          'run', 'download', String(artifact.workflowRunId),
          '--repo', repository,
          '--name', artifactName,
          '--dir', destination,
        ], { stdio: 'pipe' })
        const payload = JSON.parse(readFileSync(join(destination, 'candidate-attestation.json'), 'utf8')) as unknown
        const decision = decideCiEvidenceReuse(identity, payload, repository, artifact.workflowRunId)
        if (decision.reused) return decision
      } finally {
        rmSync(destination, { recursive: true, force: true })
      }
    }
    return fallback(identity, 'attestation-not-reusable')
  } catch {
    return fallback(identity, 'attestation-unavailable')
  }
}

function parseArtifacts(value: unknown): GitHubArtifact[] {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) {
    throw new Error('ci-attestation: GitHub artifacts response is invalid')
  }
  return value.artifacts.map((artifact) => {
    if (!isRecord(artifact)
      || typeof artifact.id !== 'number'
      || typeof artifact.expired !== 'boolean'
      || !isRecord(artifact.workflow_run)
      || typeof artifact.workflow_run.id !== 'number') {
      throw new Error('ci-attestation: GitHub artifact is invalid')
    }
    return {
      id: artifact.id,
      expired: artifact.expired,
      workflowRunId: artifact.workflow_run.id,
    }
  }).sort((left, right) => right.id - left.id)
}

function isMergeGroupRun(value: unknown): boolean {
  return isRecord(value) && value.event === 'merge_group'
}

function hasSuccessfulCandidateVerdict(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.jobs)
    && value.jobs.some(job => isRecord(job)
      && job.name === 'candidate verdict'
      && job.status === 'completed'
      && job.conclusion === 'success')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeOutputs(identity: CiEvidenceIdentity, decision?: CiEvidenceReuseDecision): void {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath === undefined) return
  const outputs = [
    `tree=${identity.tree}`,
    `proof_key=${identity.evidenceKey}`,
    `artifact_name=ci-candidate-attestation-${identity.tree}`,
  ]
  if (decision !== undefined) {
    outputs.push(
      `reused=${String(decision.reused)}`,
      `reason=${decision.reason}`,
      `source_run_id=${decision.sourceRunId === null ? '' : String(decision.sourceRunId)}`,
    )
  }
  appendFileSync(outputPath, `${outputs.join('\n')}\n`)
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string' },
      repository: { type: 'string' },
      input: { type: 'string' },
      'run-id': { type: 'string' },
    },
  })
  const command = positionals[0]
  const root = resolve(import.meta.dirname, '..')
  const output = values.output
  if (output === undefined) throw new Error('ci-attestation: --output is required')
  if (command === 'identity') {
    const identity = createCiEvidenceIdentity(root)
    writeJson(output, identity)
    writeOutputs(identity)
    return
  }
  if (command === 'complete') {
    if (values.input === undefined || values.repository === undefined || values['run-id'] === undefined) {
      throw new Error('ci-attestation: complete requires --input, --repository, and --run-id')
    }
    const identity = JSON.parse(readFileSync(values.input, 'utf8')) as CiEvidenceIdentity
    const attestation = completeCiCandidateAttestation(identity, values.repository, Number(values['run-id']))
    writeJson(output, attestation)
    writeOutputs(identity)
    return
  }
  if (command === 'resolve') {
    if (values.repository === undefined) throw new Error('ci-attestation: resolve requires --repository')
    const identity = createCiEvidenceIdentity(root)
    const decision = resolveRemoteProof(values.repository, identity)
    writeJson(output, decision)
    writeOutputs(identity, decision)
    return
  }
  throw new Error(`ci-attestation: unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] === import.meta.filename) main()
