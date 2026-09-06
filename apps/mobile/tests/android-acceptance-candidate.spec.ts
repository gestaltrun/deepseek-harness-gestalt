import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const verifier = resolve(root, 'apps/mobile/scripts/verify-android-acceptance-candidate.sh')
const packaging = resolve(root, 'apps/mobile/scripts/build-android-release.sh')
const temporary: string[] = []

const candidate = 'a'.repeat(40)
const repository = 'gestaltrun/deepseek-harness-gestalt'
const workflowRun = `https://github.com/${repository}/actions/runs/123`
const origin = 'https://www.beikejiedeliulangmao.top'

const digest = (value: string | Buffer) =>
  `sha256:${spawnSync('shasum', ['-a', '256'], { input: value, encoding: 'utf8' }).stdout.trim().split(' ')[0]}`

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Android acceptance candidate manifest', () => {
  it('authenticates candidate, artifact, signer, origin, packaging script, and workflow provenance', () => {
    const fixture = createFixture()
    expect(run(fixture).status).toBe(0)
  })

  it('rejects changed artifact, signer, origin, workflow, and packaging provenance', () => {
    for (const mutation of ['artifact', 'signer', 'origin', 'workflow', 'packaging'] as const) {
      const fixture = createFixture()
      if (mutation === 'artifact') writeFileSync(fixture.apk, 'changed')
      else {
        const manifest = JSON.parse(readFileSync(fixture.manifest, 'utf8')) as Record<string, unknown>
        const field = {
          signer: 'signerCertificateSha256',
          origin: 'operatedOriginSha256',
          workflow: 'workflowRun',
          packaging: 'packagingScriptSha256',
        }[mutation]
        manifest[field] = mutation === 'workflow' ? `${workflowRun}-foreign` : `sha256:${'f'.repeat(64)}`
        writeFileSync(fixture.manifest, `${JSON.stringify(manifest)}\n`)
      }
      expect(run(fixture).status, mutation).not.toBe(0)
    }
  })
})

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-acceptance-candidate-'))
  temporary.push(directory)
  const apk = join(directory, 'Gestalt-0.1.3-8.apk')
  const manifest = join(directory, 'acceptance-candidate.json')
  const apksigner = join(directory, 'apksigner')
  const apkBody = 'signed-apk-fixture'
  const signer = 'b'.repeat(64)
  writeFileSync(apk, apkBody)
  writeFileSync(apksigner, `#!/usr/bin/env bash\nprintf 'Signer #1 certificate SHA-256 digest: ${signer}\\n'\n`)
  chmodSync(apksigner, 0o755)
  writeFileSync(manifest, `${JSON.stringify({
    version: 1,
    mode: 'acceptance-candidate',
    surface: 'mobile',
    candidateCommit: candidate,
    planPath: 'product-releases/0012.json',
    productVersion: '0.1.3',
    buildNumber: 8,
    repository,
    workflowRun,
    artifactDigests: { 'Gestalt-0.1.3-8.apk': digest(apkBody) },
    signerCertificateSha256: `sha256:${signer}`,
    operatedOriginSha256: digest(origin),
    packagingScriptSha256: digest(readFileSync(packaging)),
  })}\n`)
  return { apk, manifest, apksigner }
}

function run(fixture: ReturnType<typeof createFixture>) {
  return spawnSync('bash', [verifier, fixture.manifest, fixture.apk], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CANDIDATE_SHA: candidate,
      PLAN_PATH: 'product-releases/0012.json',
      MOBILE_VERSION: '0.1.3',
      MOBILE_BUILD_NUMBER: '8',
      OPERATED_ORIGIN: origin,
      EXPECTED_REPOSITORY: repository,
      EXPECTED_WORKFLOW_RUN: workflowRun,
      APKSIGNER_PATH: fixture.apksigner,
    },
  })
}
