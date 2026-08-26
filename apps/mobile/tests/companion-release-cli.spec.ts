import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPANION_RELEASE_DEVICE_CHECKS,
  COMPANION_RELEASE_FLOWS,
  COMPANION_RELEASE_PLATFORMS,
  createCompanionReleaseAttestation,
} from '../src/companion-release.ts'

const root = resolve(import.meta.dirname, '../../..')
const verifier = resolve(root, 'apps/mobile/scripts/verify-companion-release-evidence.ts')
const tsxLoader = import.meta.resolve('tsx/esm')
const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Mobile Companion release evidence CLI', () => {
  it('resolves the successful source run, named verdict, and downloaded candidate artifact', () => {
    const fixture = setupRemoteEvidence('success')
    const result = runVerifier(fixture)
    expect(result.status).toBe(0)
  })

  it('rejects an artifact run whose named verdict did not succeed', () => {
    const fixture = setupRemoteEvidence('failure')
    const result = runVerifier(fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('acceptance verdict job did not succeed')
  })

  it('rejects evidence produced by a different workflow on the same candidate', () => {
    const fixture = setupRemoteEvidence('success', 'foreign')
    const result = runVerifier(fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('source run is not the Mobile Companion acceptance workflow')
  })
})

function setupRemoteEvidence(verdict: 'success' | 'failure', workflow: 'acceptance' | 'foreign' = 'acceptance') {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-release-cli-'))
  temporary.push(directory)
  const candidateSha = git(['rev-parse', 'HEAD']).trim()
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim()
  const repository = 'gestaltrun/deepseek-harness-gestalt'
  const sourceRunId = 321
  const attestation = createCompanionReleaseAttestation({
    flows: [...COMPANION_RELEASE_FLOWS],
    devices: COMPANION_RELEASE_PLATFORMS.flatMap(platform =>
      COMPANION_RELEASE_DEVICE_CHECKS.map(check => `${platform}:${check}` as const)),
    upgradePreservedKeys: true,
    uiAcceptance: true,
    failureAcceptance: true,
    transportRiskAccepted: true,
  }, { repository, sourceRunId, candidateSha, tree })
  const source = join(directory, 'source-attestation.json')
  writeFileSync(source, `${JSON.stringify(attestation)}\n`)
  const gh = join(directory, 'gh')
  const ghProgram = join(directory, 'gh.cjs')
  writeFileSync(ghProgram, `
const { cpSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'api') {
  const endpoint = args[1]
  if (endpoint.includes('/actions/workflows/')) process.stdout.write(JSON.stringify({ id: 9001, path: '.github/workflows/mobile-companion-acceptance.yml' }))
  else if (endpoint.includes('/jobs?')) process.stdout.write(JSON.stringify({ jobs: [{ name: 'mobile companion acceptance verdict', status: 'completed', conclusion: process.env.FAKE_VERDICT }] }))
  else if (endpoint.includes('/artifacts?')) process.stdout.write(JSON.stringify({ artifacts: [{ name: 'mobile-companion-acceptance-' + process.env.FAKE_SHA, expired: false }] }))
  else process.stdout.write(JSON.stringify({ workflow_id: Number(process.env.FAKE_WORKFLOW_ID), path: process.env.FAKE_WORKFLOW_PATH, event: 'workflow_dispatch', head_sha: process.env.FAKE_SHA, status: 'completed', conclusion: 'success' }))
} else if (args[0] === 'run' && args[1] === 'download') {
  const destination = args[args.indexOf('--dir') + 1]
  mkdirSync(destination, { recursive: true })
  cpSync(process.env.FAKE_ATTESTATION_SOURCE, join(destination, 'companion-release-attestation.json'))
} else process.exit(2)
`)
  writeFileSync(gh, `#!/usr/bin/env node
require('./gh.cjs')
`)
  writeFileSync(join(directory, 'gh.cmd'), `@"${process.execPath}" "%~dp0gh.cjs" %*\r\n`)
  chmodSync(gh, 0o755)
  return { directory, candidateSha, repository, sourceRunId, source, verdict, workflow }
}

function runVerifier(fixture: ReturnType<typeof setupRemoteEvidence>) {
  return spawnSync(process.execPath, [
    '--import', tsxLoader,
    verifier,
    '--repository', fixture.repository,
    '--source-run-id', String(fixture.sourceRunId),
    '--candidate-sha', fixture.candidateSha,
    '--transport-risk-accepted', 'true',
    '--test-flight', 'true',
    '--android-apk', 'true',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.directory}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_SHA: fixture.candidateSha,
      FAKE_VERDICT: fixture.verdict,
      FAKE_WORKFLOW_ID: fixture.workflow === 'acceptance' ? '9001' : '9002',
      FAKE_WORKFLOW_PATH: fixture.workflow === 'acceptance'
        ? '.github/workflows/mobile-companion-acceptance.yml'
        : '.github/workflows/foreign.yml',
      FAKE_ATTESTATION_SOURCE: fixture.source,
    },
  })
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}
