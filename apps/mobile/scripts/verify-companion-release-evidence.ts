/** Create or resolve immutable candidate-bound Mobile Companion acceptance evidence. */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createCompanionReleaseAttestation,
  verifyCompanionReleaseAttestation,
} from '../src/companion-release.ts'

const ARTIFACT_FILE = 'companion-release-attestation.json'
const VERDICT_JOB = 'mobile companion acceptance verdict'
const ACCEPTANCE_WORKFLOW_FILE = 'mobile-companion-acceptance.yml'
const ACCEPTANCE_WORKFLOW_PATH = `.github/workflows/${ACCEPTANCE_WORKFLOW_FILE}`

const { values } = parseArgs({
  options: {
    create: { type: 'boolean', default: false },
    repository: { type: 'string' },
    'source-run-id': { type: 'string' },
    'candidate-sha': { type: 'string' },
    output: { type: 'string' },
    'transport-risk-accepted': { type: 'string', default: 'false' },
    'test-flight': { type: 'string', default: 'true' },
    'android-apk': { type: 'string', default: 'true' },
  },
  strict: true,
})

const repository = required(values.repository, 'repository')
const sourceRunId = positiveInteger(required(values['source-run-id'], 'source-run-id'), 'source-run-id')
const candidateSha = required(values['candidate-sha'], 'candidate-sha')
const tree = git(['rev-parse', 'HEAD^{tree}']).trim()

if (values.create) {
  const source = process.env.MOBILE_ACCEPTANCE_EVIDENCE
  if (source === undefined) throw new Error('companion-release-evidence: MOBILE_ACCEPTANCE_EVIDENCE is required')
  const output = required(values.output, 'output')
  const evidence = JSON.parse(source) as unknown
  const attestation = createCompanionReleaseAttestation(evidence, {
    repository, sourceRunId, candidateSha, tree,
  })
  writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`)
} else {
  verifySourceRun(repository, sourceRunId, candidateSha)
  const artifactName = `mobile-companion-acceptance-${candidateSha}`
  verifyUniqueArtifact(repository, sourceRunId, artifactName)
  const destination = mkdtempSync(join(tmpdir(), 'dsh-mobile-acceptance-'))
  try {
    execFileSync('gh', [
      'run', 'download', String(sourceRunId),
      '--repo', repository,
      '--name', artifactName,
      '--dir', destination,
    ], { stdio: 'pipe' })
    const candidate = JSON.parse(readFileSync(join(destination, ARTIFACT_FILE), 'utf8')) as unknown
    verifyCompanionReleaseAttestation(candidate, {
      repository, sourceRunId, candidateSha, tree,
    }, {
      testFlight: exactBoolean(values['test-flight'], 'test-flight'),
      androidApk: exactBoolean(values['android-apk'], 'android-apk'),
      transportRiskAccepted: exactBoolean(values['transport-risk-accepted'], 'transport-risk-accepted'),
    })
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

function verifySourceRun(repository: string, runId: number, candidateSha: string): void {
  const run = ghJson(`/repos/${repository}/actions/runs/${String(runId)}`)
  if (!isRecord(run)
    || run.event !== 'workflow_dispatch'
    || run.head_sha !== candidateSha
    || run.status !== 'completed'
    || run.conclusion !== 'success') {
    throw new Error('companion-release-evidence: acceptance source run is not a successful candidate run')
  }
  const workflow = ghJson(`/repos/${repository}/actions/workflows/${ACCEPTANCE_WORKFLOW_FILE}`)
  if (!isRecord(workflow)
    || typeof workflow.id !== 'number'
    || workflow.path !== ACCEPTANCE_WORKFLOW_PATH
    || run.workflow_id !== workflow.id
    || run.path !== ACCEPTANCE_WORKFLOW_PATH) {
    throw new Error('companion-release-evidence: source run is not the Mobile Companion acceptance workflow')
  }
  const jobs = ghJson(`/repos/${repository}/actions/runs/${String(runId)}/jobs?per_page=100`)
  if (!isRecord(jobs) || !Array.isArray(jobs.jobs)
    || !jobs.jobs.some(job => isRecord(job)
      && job.name === VERDICT_JOB
      && job.status === 'completed'
      && job.conclusion === 'success')) {
    throw new Error('companion-release-evidence: acceptance verdict job did not succeed')
  }
}

function verifyUniqueArtifact(repository: string, runId: number, artifactName: string): void {
  const response = ghJson(`/repos/${repository}/actions/runs/${String(runId)}/artifacts?per_page=100`)
  if (!isRecord(response) || !Array.isArray(response.artifacts)) {
    throw new Error('companion-release-evidence: artifact response is invalid')
  }
  const matching = response.artifacts.filter(artifact => isRecord(artifact)
    && artifact.name === artifactName
    && artifact.expired === false)
  if (matching.length !== 1) {
    throw new Error('companion-release-evidence: expected exactly one unexpired candidate artifact')
  }
}

function ghJson(endpoint: string): unknown {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' })) as unknown
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`companion-release-evidence: ${name} is required`)
  return value
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`companion-release-evidence: ${name} must be a positive integer`)
  }
  return parsed
}

function exactBoolean(value: string, name: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`companion-release-evidence: ${name} must be true or false`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
