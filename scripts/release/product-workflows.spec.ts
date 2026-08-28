import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

describe('product release workflows', () => {
  it('keeps each release lane manually recoverable and exposes typed workflow_call inputs', () => {
    const desktopSource = text('.github/workflows/desktop-release.yml')
    const desktop = workflow('.github/workflows/desktop-release.yml')
    const mobile = workflow('.github/workflows/mobile-release.yml')
    const image = workflow('.github/workflows/platform-image.yml')
    const deploy = workflow('.github/workflows/platform-deploy.yml')

    expect(desktop.on).toHaveProperty('workflow_dispatch')
    expect(desktop.on).toHaveProperty('workflow_call')
    expect(input(desktop, 'workflow_call', 'candidate_sha')).toMatchObject({ required: true, type: 'string' })
    expect(input(desktop, 'workflow_call', 'plan_path')).toMatchObject({ required: true, type: 'string' })
    expect(input(desktop, 'workflow_call', 'version')).toMatchObject({ required: true, type: 'string' })
    expect(input(desktop, 'workflow_call', 'artifact_run_id')).toMatchObject({ required: false, type: 'string' })
    expect(input(desktop, 'workflow_call', 'recover_artifacts')).toMatchObject({ required: true, type: 'boolean' })
    expect(input(desktop, 'workflow_call', 'publish')).toMatchObject({ required: true, type: 'boolean' })
    expect(desktopSource).not.toContain('GITHUB_EVENT_NAME')
    expect(desktopSource).toContain('release-candidate.json')
    expect(desktopSource).toContain('actions/runs/$DESKTOP_ARTIFACT_RUN_ID')
    expect(desktopSource).toContain('actions/runs/$DESKTOP_ARTIFACT_RUN_ID/jobs')
    expect(desktopSource).toContain('actions/runs/$DESKTOP_ARTIFACT_RUN_ID/artifacts')

    expect(mobile.on).toHaveProperty('workflow_dispatch')
    expect(mobile.on).toHaveProperty('workflow_call')
    expect(input(mobile, 'workflow_call', 'candidate_sha')).toMatchObject({ required: true, type: 'string' })
    expect(input(mobile, 'workflow_call', 'plan_path')).toMatchObject({ required: true, type: 'string' })
    expect(input(mobile, 'workflow_call', 'version')).toMatchObject({ required: true, type: 'string' })
    expect(input(mobile, 'workflow_call', 'build_number')).toMatchObject({ required: true, type: 'number' })
    expect(input(mobile, 'workflow_call', 'artifact_run_id')).toMatchObject({ required: false, type: 'string' })
    expect(input(mobile, 'workflow_call', 'recover_artifacts')).toMatchObject({ required: true, type: 'boolean' })
    expect(input(mobile, 'workflow_call', 'publish_github')).toMatchObject({ required: true, type: 'boolean' })

    expect(image.on).toHaveProperty('workflow_dispatch')
    expect(image.on).toHaveProperty('workflow_call')
    expect(deploy.on).toHaveProperty('workflow_dispatch')
    expect(deploy.on).toHaveProperty('workflow_call')
    expect(input(deploy, 'workflow_call', 'image_identity')).toMatchObject({ required: true, type: 'string' })
    expect(input(deploy, 'workflow_call', 'image_candidate_sha')).toMatchObject({ required: true, type: 'string' })
    expect(input(deploy, 'workflow_call', 'recover')).toMatchObject({ required: true, type: 'boolean' })
    expect(input(deploy, 'workflow_call', 'publish_only')).toMatchObject({ required: true, type: 'boolean' })
    expect(input(deploy, 'workflow_call', 'deployment_run_id')).toMatchObject({ required: false, type: 'string' })
    for (const source of [desktopSource, text('.github/workflows/mobile-release.yml'), text('.github/workflows/platform-image.yml'), text('.github/workflows/platform-deploy.yml')]) {
      expect(source).toContain('git merge-base --is-ancestor "$workflow_head" refs/remotes/origin/master')
      expect(source).toContain('trustedWorkflowHeadCommits')
    }
  })

  it('projects the tracked Mobile marketing/build versions and publishes a durable prerelease', () => {
    const source = text('.github/workflows/mobile-release.yml')
    const mobile = workflow('.github/workflows/mobile-release.yml')
    expect(source).not.toContain('vars.MOBILE_VERSION')
    expect(source).not.toContain('vars.MOBILE_BUILD_NUMBER')
    expect(source).toContain('apps/mobile/release.json')
    expect(source).toContain('git merge-base --is-ancestor "$workflow_head" refs/remotes/origin/master')
    expect(source).not.toContain('github.ref == \'refs/heads/master\'')
    expect(source).toContain('inputs.version')
    expect(source).toContain('inputs.build_number')
    expect(source).toContain('inputs.artifact_run_id')
    expect(source).toContain('inputs.recover_artifacts')
    expect(source).not.toContain('GITHUB_EVENT_NAME')
    expect(source).toContain('gh run download "$MOBILE_ARTIFACT_RUN_ID"')
    expect(source).toContain('value: ${{ jobs.channel-evidence.outputs.testflight_build }}')
    expect(source).toContain('release-candidate.json')
    expect(source).toContain('actions/runs/$MOBILE_ARTIFACT_RUN_ID')
    expect(source).toContain('actions/runs/$MOBILE_ARTIFACT_RUN_ID/jobs')
    expect(source).toContain('actions/runs/$MOBILE_ARTIFACT_RUN_ID/artifacts')
    expect(source).toContain('TestFlight recovery from signed IPA')
    const publish = job(mobile, 'publish')
    expect(publish.needs).toEqual(['release-authorization', 'release-version', 'channel-evidence'])
    const serialized = JSON.stringify(publish)
    expect(serialized).toContain('gh release create')
    expect(serialized).toContain('--prerelease')
    expect(serialized).toContain('SHA256SUMS')
    expect(serialized).toContain('https://testflight.apple.com/join/pKCZtn7q')
    expect(serialized).toContain('gh release edit')
  })

  it('promotes a candidate-matched immutable Platform image and never plans latest', () => {
    const imageSource = text('.github/workflows/platform-image.yml')
    const deploySource = text('.github/workflows/platform-deploy.yml')
    expect(imageSource).not.toContain('type=raw,value=latest')
    expect(imageSource).toContain('value: ${{ jobs.provenance.outputs.digest || jobs.evidence.outputs.digest }}')
    expect(deploySource).not.toContain('default: latest')
    expect(deploySource).not.toContain('sha-... or latest')
    expect(deploySource).toContain('assertImmutablePlatformCandidate')
    expect(deploySource).toContain('IMAGE_CANDIDATE_SHA: ${{ inputs.image_candidate_sha }}')
    expect(deploySource).toContain('IMAGE_IDENTITY: ${{ inputs.image_identity }}')
    expect(deploySource).toContain('tag="platform-v${PLATFORM_VERSION}"')
    expect(deploySource).toContain('gh release create "$tag"')
    expect(deploySource).toContain('PLATFORM_IMAGE_IDENTITY: ${{ inputs.image_identity }}')
    expect(deploySource).toContain('inputs.publish_only')
    expect(deploySource).toContain('inputs.deployment_run_id')
    expect(deploySource).toContain('platform-deployment-candidate-')
    expect(imageSource).toContain('actions/runs/$PLATFORM_IMAGE_RUN_ID/jobs')
    expect(imageSource).toContain('actions/runs/$PLATFORM_IMAGE_RUN_ID/artifacts')
    expect(deploySource).toContain('actions/runs/$PLATFORM_DEPLOYMENT_RUN_ID/jobs')
    expect(deploySource).toContain('actions/runs/$PLATFORM_DEPLOYMENT_RUN_ID/artifacts')
  })

  it('fails direct release workflows when a requested external channel fails', () => {
    for (const path of [
      '.github/workflows/desktop-release.yml',
      '.github/workflows/mobile-release.yml',
      '.github/workflows/platform-deploy.yml',
    ]) {
      expect(text(path)).not.toContain('continue-on-error: true')
    }
    expect(text('.github/workflows/product-release.yml')).toContain('if: ${{ always() }}')
  })

  it('updates a Product Release PR without publishing and coordinates only selected lanes', () => {
    const planner = text('.github/workflows/product-release-plan.yml')
    const coordinatorSource = text('.github/workflows/product-release.yml')
    const coordinator = workflow('.github/workflows/product-release.yml')
    expect(planner).toContain('product-release:prepare --write')
    expect(planner).toContain('automation/product-release')
    expect(planner).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1')
    expect(planner).toContain('DSH_RELEASE_APP_CLIENT_ID')
    expect(planner).toContain('DSH_RELEASE_APP_PRIVATE_KEY')
    expect(planner).toContain('steps.app-token.outputs.token')
    expect(planner).toContain('gh pr create')
    expect(planner).not.toContain('gh release create')
    expect(input(coordinator, 'workflow_dispatch', 'candidate_sha')).toMatchObject({ required: true, type: 'string' })
    expect(coordinatorSource).toContain('ref: ${{ inputs.candidate_sha }}')
    expect(coordinatorSource).toContain('candidate checkout does not match')
    expect(coordinatorSource).toContain('apps/mobile/release.json')
    expect(coordinatorSource).toContain('product-release:validate-candidate')
    expect(coordinatorSource).toContain('refs/remotes/origin/master')
    expect(job(coordinator, 'desktop').uses).toBe('./.github/workflows/desktop-release.yml')
    expect(job(coordinator, 'mobile').uses).toBe('./.github/workflows/mobile-release.yml')
    expect(job(coordinator, 'platform-image').uses).toBe('./.github/workflows/platform-image.yml')
    expect(job(coordinator, 'platform-deploy').uses).toBe('./.github/workflows/platform-deploy.yml')
    expect(JSON.stringify(job(coordinator, 'manifest'))).toContain('product-release-manifest')
    expect(job(coordinator, 'manifest').if).toBe('${{ always() }}')
    expect(coordinatorSource).toContain('actions/runs/$GITHUB_RUN_ID')
    expect(coordinatorSource).toContain('releaseUrl')
    expect(coordinatorSource).toContain('reason')
    expect(coordinatorSource).toContain('needs.mobile.outputs.testflight_build')
    expect(coordinatorSource).not.toContain('--argjson mobileBuild "${MOBILE_BUILD:-0}"')
    expect(coordinatorSource).not.toContain('image_candidate_sha: ${{ needs.platform-image.outputs.candidate_sha || inputs.candidate_sha }}')
  })

  it('grants least-required caller permissions to reusable release lanes', () => {
    const coordinator = workflow('.github/workflows/product-release.yml')
    expect(record(job(coordinator, 'desktop').permissions, 'desktop permissions')).toMatchObject({ contents: 'write' })
    expect(record(job(coordinator, 'mobile').permissions, 'mobile permissions')).toMatchObject({ contents: 'write', actions: 'read' })
    expect(record(job(coordinator, 'platform-image').permissions, 'platform image permissions')).toMatchObject({ contents: 'read', packages: 'write' })
    expect(record(job(coordinator, 'platform-deploy').permissions, 'platform deploy permissions')).toMatchObject({ contents: 'write', packages: 'read', 'id-token': 'write' })
  })

  it('uses per-surface summaries in Desktop, Mobile, and Platform notes', () => {
    const desktop = text('.github/workflows/desktop-release.yml')
    const mobile = text('.github/workflows/mobile-release.yml')
    const platform = text('.github/workflows/platform-deploy.yml')
    expect(desktop).toContain('render-release-notes.mjs')
    expect(mobile).toContain('.releaseUnits.mobile.summaries[]')
    expect(platform).toContain('.releaseUnits.platform.summaries[]')
  })

  it('runs release-intent validation in pull-request and merge-queue preflight', () => {
    const ci = text('.github/workflows/ci.yml')
    expect(ci).toContain('pnpm product-release:validate --base "$BASE_SHA" --head "$HEAD_SHA"')
    expect(ci).toContain("github.event_name == 'pull_request' || github.event_name == 'merge_group'")
  })
})

function text(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

function workflow(path: string): Record<string, unknown> {
  const parsed = load(text(path), { json: true })
  return record(parsed, path)
}

function input(owner: Record<string, unknown>, event: string, name: string): Record<string, unknown> {
  return record(record(record(record(owner.on, 'on')[event], event).inputs, 'inputs')[name], name)
}

function job(owner: Record<string, unknown>, name: string): Record<string, unknown> {
  return record(record(owner.jobs, 'jobs')[name], name)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}
