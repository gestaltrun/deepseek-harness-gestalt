import { execFileSync, spawnSync } from 'node:child_process'
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
  it('authenticates candidate, signed APK, signer, baked runtime identity, packaging, and workflow provenance', () => {
    const fixture = createFixture()
    expect(run(fixture).status).toBe(0)
  })

  it('rejects changed APK, signer, baked origin, duplicate runtime identity, workflow, and packaging provenance', () => {
    for (const mutation of ['artifact', 'signer', 'baked-origin', 'duplicate-identity', 'workflow', 'packaging'] as const) {
      const fixture = createFixture(mutation === 'baked-origin' ? 'https://wrong.example' : origin,
        mutation === 'duplicate-identity')
      if (mutation === 'artifact') writeFileSync(fixture.apk, 'changed')
      else if (mutation === 'signer' || mutation === 'workflow' || mutation === 'packaging') {
        const manifest = JSON.parse(readFileSync(fixture.manifest, 'utf8')) as Record<string, unknown>
        const field = {
          signer: 'signerCertificateSha256',
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

function createFixture(bakedOrigin = origin, duplicateIdentity = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-acceptance-candidate-'))
  temporary.push(directory)
  const apk = join(directory, 'Gestalt-0.1.3-8.apk')
  const manifest = join(directory, 'acceptance-candidate.json')
  const apksigner = join(directory, 'apksigner')
  const identityDirectory = join(directory, 'assets/public')
  execFileSync('mkdir', ['-p', identityDirectory])
  const runtimeIdentityBody = `${JSON.stringify({ version: 1, origin: bakedOrigin })}\n`
  writeFileSync(join(identityDirectory, 'dsh-mobile-runtime-identity.json'), runtimeIdentityBody)
  execFileSync('zip', ['-q', '-r', apk, 'assets'], { cwd: directory })
  if (duplicateIdentity) {
    execFileSync('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "a") as archive:',
      '    archive.writestr("assets/public/dsh-mobile-runtime-identity.json", sys.argv[2])',
    ].join('\n'), apk, runtimeIdentityBody])
  }
  const signer = 'b'.repeat(64)
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
    artifactDigests: { 'Gestalt-0.1.3-8.apk': digest(readFileSync(apk)) },
    signerCertificateSha256: `sha256:${signer}`,
    runtimeIdentitySha256: digest(runtimeIdentityBody),
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
