import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const validator = resolve(import.meta.dirname, '../scripts/validate-mobile-release-mode.sh')

describe('Mobile release mode authorization', () => {
  it('accepts a protected candidate build only with candidate-scoped transport-risk acceptance', () => {
    expect(run({ CANDIDATE_BUILD_ONLY: 'true', ACCEPT_TRANSPORT_RISK: 'true' }).status).toBe(0)

    const rejected = run({ CANDIDATE_BUILD_ONLY: 'true' })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('candidate-scoped transport-risk acceptance')
  })

  it('rejects every publication, TestFlight, acceptance, and recovery input in candidate-build-only mode', () => {
    for (const input of [
      { UPLOAD_TESTFLIGHT: 'true' },
      { PUBLISH_GITHUB: 'true' },
      { RECOVER_ARTIFACTS: 'true' },
      { ARTIFACT_RUN_ID: '123' },
      { ACCEPTANCE_RUN_ID: '456' },
    ]) {
      const result = run({ CANDIDATE_BUILD_ONLY: 'true', ACCEPT_TRANSPORT_RISK: 'true', ...input })
      expect(result.status, JSON.stringify(input)).not.toBe(0)
      expect(result.stderr).toContain('candidate-build-only forbids')
    }
  })

  it('preserves the normal requirement for candidate-bound acceptance', () => {
    const missing = run({})
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('candidate-bound acceptance run')
    expect(run({ ACCEPTANCE_RUN_ID: '456' }).status).toBe(0)
  })
})

function run(overrides: Record<string, string>) {
  return spawnSync('bash', [validator], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CANDIDATE_BUILD_ONLY: 'false',
      UPLOAD_TESTFLIGHT: 'false',
      PUBLISH_GITHUB: 'false',
      RECOVER_ARTIFACTS: 'false',
      ACCEPT_TRANSPORT_RISK: 'false',
      ARTIFACT_RUN_ID: '',
      ACCEPTANCE_RUN_ID: '',
      ...overrides,
    },
  })
}
