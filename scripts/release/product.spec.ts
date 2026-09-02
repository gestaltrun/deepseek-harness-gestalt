import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  aggregateProductRelease,
  assertImmutablePlatformCandidate,
  computeProductImpact,
  parseReleaseIntent,
  renderDesktopReleaseNotes,
  renderReleaseManifest,
  validatePriorReleaseRun,
  validateProductReleaseCandidate,
  validateReleaseArtifactManifest,
  validateReleaseIntentAdditions,
  validateProductReleasePlanChange,
  validateReleaseIntent,
  writeProductRelease,
} from './product.ts'

const all = ['desktop', 'mobile', 'platform'] as const
const mobileGeneratedPaths = [
  'apps/mobile/package.json',
  'apps/mobile/release.json',
  'product-releases/0001.json',
  'product-releases/state.json',
] as const

describe('product release intent', () => {
  it('parses one versioned intent and rejects missing summaries', () => {
    expect(parseReleaseIntent({
      version: 1,
      id: '414-release-orchestration',
      summary: { en: 'Coordinate product release units.', zh: '协调产品发布单元。' },
      releases: { desktop: 'patch', mobile: 'minor', platform: 'none' },
      compatibilityExceptions: [],
    }, 'intent.json').releases.mobile).toBe('minor')
    expect(() => parseReleaseIntent({
      version: 1,
      id: 'invalid',
      summary: { en: '', zh: '无效。' },
      releases: { desktop: 'none', mobile: 'none', platform: 'none' },
      compatibilityExceptions: [],
    }, 'intent.json')).toThrow('summary')
    expect(() => parseReleaseIntent({
      ...intentValue('unknown-field'),
      internalNote: 'must not persist',
    }, 'intent.json')).toThrow('unknown field')
    expect(() => parseReleaseIntent({
      ...intentValue('unknown-exception'),
      compatibilityExceptions: [{ releaseUnit: 'desktop', reason: 'Reviewed.', extra: true }],
    }, 'intent.json')).toThrow('unknown field')
  })

  it('fails closed when an intent omits an impacted release unit', () => {
    const intent = parseReleaseIntent({
      version: 1,
      id: 'relay-change',
      summary: { en: 'Update the shared Companion protocol.', zh: '更新共享 Companion 协议。' },
      releases: { desktop: 'patch', mobile: 'patch', platform: 'none' },
      compatibilityExceptions: [],
    }, 'intent.json')
    expect(() => validateReleaseIntent(intent, new Set(all))).toThrow('platform')
  })

  it('accepts reviewed compatibility exceptions and conservative over-reporting', () => {
    const excepted = parseReleaseIntent({
      version: 1,
      id: 'compatible-platform-wire',
      summary: { en: 'Add an optional Platform response field.', zh: '增加可选 Platform 响应字段。' },
      releases: { desktop: 'patch', mobile: 'patch', platform: 'none' },
      compatibilityExceptions: [{ releaseUnit: 'platform', reason: 'The producer already emits the optional field.' }],
    }, 'intent.json')
    expect(validateReleaseIntent(excepted, new Set(all))).toEqual([])

    const overReported = parseReleaseIntent({
      version: 1,
      id: 'desktop-only',
      summary: { en: 'Repackage the Desktop installer.', zh: '重新打包桌面安装器。' },
      releases: { desktop: 'patch', mobile: 'patch', platform: 'none' },
      compatibilityExceptions: [],
    }, 'intent.json')
    expect(validateReleaseIntent(overReported, new Set(['desktop']))).toEqual([])
  })

  it('accepts an optional unique unconsumed intent when one is added', async () => {
    const root = await fixtureRepository()
    await mkdir(join(root, '.release-intents'), { recursive: true })
    await writeFile(join(root, '.release-intents/already-consumed.json'), `${JSON.stringify(intentValue('already-consumed'), null, 2)}\n`)
    await writeFile(join(root, '.release-intents/new-release.json'), `${JSON.stringify(intentValue('new-release'), null, 2)}\n`)
    await writeFile(join(root, 'product-releases/state.json'), '{\n  "version": 1,\n  "nextSequence": 2,\n  "consumedIntentIds": ["already-consumed"]\n}\n')

    await expect(validateReleaseIntentAdditions(root, ['.release-intents/new-release.json'], new Set(['desktop'])))
      .resolves.toEqual([expect.objectContaining({ id: 'new-release' })])
    await expect(validateReleaseIntentAdditions(root, ['.release-intents/already-consumed.json'], new Set(['desktop'])))
      .rejects.toThrow('already consumed')
    await expect(validateReleaseIntentAdditions(root, [], new Set(['desktop'])))
      .resolves.toEqual([])

    await writeFile(join(root, '.release-intents/mobile-release.json'), `${JSON.stringify(intentValue('mobile-release', { desktop: 'none', mobile: 'patch', platform: 'none' }), null, 2)}\n`)
    await expect(validateReleaseIntentAdditions(root, [
      '.release-intents/new-release.json',
      '.release-intents/mobile-release.json',
    ], new Set(['desktop', 'mobile']))).resolves.toEqual([
      expect.objectContaining({ id: 'mobile-release' }),
      expect.objectContaining({ id: 'new-release' }),
    ])

    await writeFile(join(root, '.release-intents/duplicate.json'), `${JSON.stringify(intentValue('new-release'), null, 2)}\n`)
    await expect(validateReleaseIntentAdditions(root, ['.release-intents/new-release.json'], new Set(['desktop'])))
      .rejects.toThrow('duplicate product release intent id')
  })

  it('does not let one aggregated intent exception waive another intent', async () => {
    const root = await fixtureRepository()
    await mkdir(join(root, '.release-intents'), { recursive: true })
    const excepted = {
      ...intentValue('excepted-platform', { desktop: 'none', mobile: 'none', platform: 'none' }),
      compatibilityExceptions: [{ releaseUnit: 'platform', reason: 'This intent does not alter the producer.' }],
    }
    await writeFile(join(root, '.release-intents/excepted-platform.json'), `${JSON.stringify(excepted, null, 2)}\n`)
    await writeFile(join(root, '.release-intents/other-change.json'), `${JSON.stringify(intentValue('other-change', { desktop: 'none', mobile: 'none', platform: 'none' }), null, 2)}\n`)
    await writeFile(join(root, 'product-releases/state.json'), '{\n  "version": 1,\n  "nextSequence": 1,\n  "consumedIntentIds": []\n}\n')
    await expect(validateReleaseIntentAdditions(root, [
      '.release-intents/excepted-platform.json',
      '.release-intents/other-change.json',
    ], new Set(['platform']))).rejects.toThrow('platform')
  })
})

describe('product impact planner', () => {
  it('finds direct, transitive, protocol, and explicit workflow impact', async () => {
    const root = await fixtureRepository()
    await expect(computeProductImpact(root, ['apps/mobile/src/App.tsx']))
      .resolves.toEqual(new Set(['mobile']))
    await expect(computeProductImpact(root, ['packages/shared/runtime/src/index.ts']))
      .resolves.toEqual(new Set(['desktop', 'mobile']))
    await expect(computeProductImpact(root, ['packages/wire/protocol/src/index.ts']))
      .resolves.toEqual(new Set(all))
    await expect(computeProductImpact(root, ['.github/workflows/platform-deploy.yml']))
      .resolves.toEqual(new Set(['platform']))
  })

  it('treats docs and tests as empty and unknown production inputs as all units', async () => {
    const root = await fixtureRepository()
    await expect(computeProductImpact(root, ['docs/release.md', 'apps/mobile/tests/app.spec.ts']))
      .resolves.toEqual(new Set())
    await expect(computeProductImpact(root, ['tooling/unmapped-release-input.ts']))
      .resolves.toEqual(new Set(all))
  })
})

describe('product release plan', () => {
  it('aggregates the highest bump and increments one tracked Mobile build number', async () => {
    const root = await fixtureRepository()
    const intents = [
      intent('one', { desktop: 'patch', mobile: 'patch', platform: 'none' }),
      intent('two', { desktop: 'minor', mobile: 'none', platform: 'major' }),
    ]
    const plan = await aggregateProductRelease(root, intents, {
      version: 1,
      nextSequence: 7,
      consumedIntentIds: [],
    })
    expect(plan.sequence).toBe(7)
    expect(plan.releaseUnits.desktop).toMatchObject({ selected: true, version: '0.2.0', tag: 'gestalt-v0.2.0' })
    expect(plan.releaseUnits.mobile).toMatchObject({ selected: true, version: '0.1.1', buildNumber: 6, tag: 'mobile-v0.1.1' })
    expect(plan.releaseUnits.platform).toMatchObject({ selected: true, version: '1.0.0', tag: 'platform-v1.0.0' })
    expect(plan.releaseUnits.desktop).toMatchObject({ summaries: [{ en: 'Summary for one.', zh: 'one 的发布摘要。' }, { en: 'Summary for two.', zh: 'two 的发布摘要。' }] })
    expect(plan.releaseUnits.mobile).toMatchObject({ summaries: [{ en: 'Summary for one.', zh: 'one 的发布摘要。' }] })
    expect(plan.releaseUnits.platform).toMatchObject({ summaries: [{ en: 'Summary for two.', zh: 'two 的发布摘要。' }] })
    expect(plan.intentIds).toEqual(['one', 'two'])
    const notes = renderDesktopReleaseNotes(plan, '0123456789abcdef0123456789abcdef01234567')
    expect(notes).toMatchObject({
      version: '0.2.0',
      tag: 'gestalt-v0.2.0',
      source: { baselineCommit: '0123456789abcdef0123456789abcdef01234567' },
    })
    expect(notes.content.en.sections[0]?.items).toEqual(['Summary for one.', 'Summary for two.'])
    expect(notes.content.zh.sections[0]?.items).toEqual(['one 的发布摘要。', 'two 的发布摘要。'])
  })

  it('writes one retry-stable plan and updates each selected source authority', async () => {
    const root = await fixtureRepository()
    const releaseIntent = intent('mobile-release', { desktop: 'none', mobile: 'patch', platform: 'none' })
    const state = { version: 1 as const, nextSequence: 1, consumedIntentIds: [] }
    const plan = await aggregateProductRelease(root, [releaseIntent], state)
    await writeProductRelease(root, plan, state)
    const firstPlan = await readFile(join(root, 'product-releases/0001.json'), 'utf8')
    await writeProductRelease(root, plan, state)
    expect(await readFile(join(root, 'product-releases/0001.json'), 'utf8')).toBe(firstPlan)
    expect(jsonRecord(await readFile(join(root, 'apps/mobile/package.json'), 'utf8')).version).toBe('0.1.1')
    expect(jsonRecord(await readFile(join(root, 'apps/mobile/release.json'), 'utf8')).buildNumber).toBe(6)
    expect(JSON.parse(await readFile(join(root, 'product-releases/state.json'), 'utf8'))).toEqual({
      version: 1,
      nextSequence: 2,
      consumedIntentIds: ['mobile-release'],
    })
  })

  it('admits only a generated Product Release PR without another intent', async () => {
    const root = await fixtureRepository()
    const { state, plan } = await plannedMobileRelease(root)
    await writeProductRelease(root, plan, state)
    await expect(validateProductReleasePlanChange(root, mobileGeneratedPaths)).resolves.toBe(1)
    await expect(validateProductReleasePlanChange(root, [
      'apps/mobile/package.json',
      'product-releases/0001.json',
      'product-releases/state.json',
      'tooling/unplanned.ts',
    ])).rejects.toThrow('unexpected path')
    await expect(validateProductReleasePlanChange(root, ['product-releases/state.json']))
      .rejects.toThrow('exactly one numbered plan')
  })

  it('recomputes a generated plan from the base ledger and rejects forged bumps', async () => {
    const root = await fixtureRepository()
    await mkdir(join(root, '.release-intents'), { recursive: true })
    await writeFile(join(root, '.release-intents/planned-mobile.json'), `${JSON.stringify(intentValue('planned-mobile', { desktop: 'none', mobile: 'patch', platform: 'none' }), null, 2)}\n`)
    git(root, 'init')
    git(root, 'config', 'core.hooksPath', '/dev/null')
    git(root, 'config', 'user.email', 'release-test@example.com')
    git(root, 'config', 'user.name', 'Release Test')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'base')
    git(root, 'tag', 'gestalt-v0.1.0')
    const base = git(root, 'rev-parse', 'HEAD').trim()
    const { state, plan } = await plannedMobileRelease(root)
    await writeProductRelease(root, plan, state)
    const changed = mobileGeneratedPaths
    await expect(validateProductReleasePlanChange(root, changed, 'HEAD')).resolves.toBe(1)
    await writeFile(join(root, 'product-releases/0001.json'), `${JSON.stringify({ ...plan, internalNote: true }, null, 2)}\n`)
    await expect(validateProductReleasePlanChange(root, changed, 'HEAD')).rejects.toThrow('unknown field')
    await writeFile(join(root, 'product-releases/0001.json'), `${JSON.stringify(plan, null, 2)}\n`)
    const releaseStatePath = join(root, 'product-releases/state.json')
    const releaseState = jsonRecord(await readFile(releaseStatePath, 'utf8'))
    await writeFile(releaseStatePath, `${JSON.stringify({ ...releaseState, internalNote: true }, null, 2)}\n`)
    await expect(validateProductReleasePlanChange(root, changed, 'HEAD')).rejects.toThrow('unknown field')
    await writeFile(releaseStatePath, `${JSON.stringify(releaseState, null, 2)}\n`)
    const mobilePackagePath = join(root, 'apps/mobile/package.json')
    const mobilePackage = jsonRecord(await readFile(mobilePackagePath, 'utf8'))
    await writeFile(mobilePackagePath, `${JSON.stringify({ ...mobilePackage, scripts: { hitchhike: 'true' } }, null, 2)}\n`)
    await expect(validateProductReleasePlanChange(root, changed, 'HEAD')).rejects.toThrow('only the version field')
    await writeFile(mobilePackagePath, `${JSON.stringify(mobilePackage, null, 2)}\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'release plan')
    const candidate = git(root, 'rev-parse', 'HEAD').trim()
    await expect(validateProductReleaseCandidate(root, 'product-releases/0001.json', candidate, candidate, 'HEAD'))
      .resolves.toMatchObject({ sequence: 1 })
    await writeFile(releaseStatePath, `${JSON.stringify({ ...releaseState, consumedIntentIds: ['forged', 'planned-mobile'] }, null, 2)}\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'forge release state')
    await expect(validateProductReleaseCandidate(root, 'product-releases/0001.json', candidate, candidate, 'HEAD'))
      .rejects.toThrow('numbered master release ledger')
    await writeFile(releaseStatePath, `${JSON.stringify(releaseState, null, 2)}\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'restore release state')
    await writeFile(join(root, '.release-intents/later-mobile.json'), `${JSON.stringify(intentValue('later-mobile', { desktop: 'none', mobile: 'patch', platform: 'none' }), null, 2)}\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'later intent')
    await expect(validateProductReleaseCandidate(root, 'product-releases/0001.json', candidate, candidate, 'HEAD'))
      .rejects.toThrow('unconsumed product release intent')
    const forged = structuredClone(plan)
    const mobile = forged.releaseUnits.mobile
    if (!mobile.selected) throw new TypeError('Mobile must be selected')
    mobile.bump = 'major'
    await writeFile(join(root, 'product-releases/0001.json'), `${JSON.stringify(forged, null, 2)}\n`)
    await expect(validateProductReleasePlanChange(root, changed, base)).rejects.toThrow('base ledger')
  }, 15_000)

  it('binds the exact plan, candidate checkout, versions, and Mobile build', async () => {
    const root = await fixtureRepository()
    const state = { version: 1 as const, nextSequence: 1, consumedIntentIds: [] }
    const plan = await aggregateProductRelease(root, [
      intent('all-release', { desktop: 'patch', mobile: 'patch', platform: 'patch' }),
    ], state)
    await writeFile(join(root, 'product-releases/0001.json'), `${JSON.stringify(plan, null, 2)}\n`)
    for (const unit of all) {
      const release = plan.releaseUnits[unit]
      await writeFile(join(root, `apps/${unit}/package.json`), `${JSON.stringify({ name: `@deepseek-ai/dsh-${unit}`, version: release.version }, null, 2)}\n`)
    }
    await writeFile(join(root, 'apps/mobile/release.json'), '{\n  "version": 1,\n  "buildNumber": 6\n}\n')
    const candidate = '0123456789abcdef0123456789abcdef01234567'
    await expect(validateProductReleaseCandidate(root, 'product-releases/0001.json', candidate, candidate))
      .resolves.toMatchObject({ sequence: 1 })
    await expect(validateProductReleaseCandidate(root, 'product-releases/0001.json', candidate, '1123456789abcdef0123456789abcdef01234567'))
      .rejects.toThrow('candidate checkout')
    await writeFile(join(root, 'apps/mobile/release.json'), '{\n  "version": 1,\n  "buildNumber": 7\n}\n')
    await expect(validateProductReleaseCandidate(root, 'product-releases/0001.json', candidate, candidate))
      .rejects.toThrow('Mobile build number')
  })
})

describe('release promotion identity and manifest', () => {
  it('rejects latest and stale Platform candidates', () => {
    const candidate = '0123456789abcdef0123456789abcdef01234567'
    const stale = '1123456789abcdef0123456789abcdef01234567'
    const digest = `ghcr.io/owner/repo/platform@sha256:${'a'.repeat(64)}`
    expect(() => assertImmutablePlatformCandidate('latest', candidate, candidate)).toThrow('full OCI digest')
    expect(() => assertImmutablePlatformCandidate(`ghcr.io/owner/repo/platform@sha256:${'a'.repeat(16)}`, candidate, candidate))
      .toThrow('full OCI digest')
    expect(() => assertImmutablePlatformCandidate(digest, candidate, stale)).toThrow('image candidate')
    expect(assertImmutablePlatformCandidate(digest, candidate, candidate)).toBe(digest)
  })

  it('records selected, skipped, blocked, and exact promotion evidence', () => {
    const manifest = renderReleaseManifest({
      planSequence: 4,
      candidateCommit: 'abc123',
      releaseUnits: {
        desktop: { state: 'released', version: '0.2.0', tag: 'gestalt-v0.2.0', artifactDigests: ['sha256:one'], workflowRun: 'https://github.com/owner/repo/actions/runs/1', releaseUrl: 'https://github.com/owner/repo/releases/tag/gestalt-v0.2.0' },
        mobile: { state: 'blocked', version: '0.1.1', tag: 'mobile-v0.1.1', reason: 'TestFlight approval is pending', workflowRun: 'https://github.com/owner/repo/actions/runs/2' },
        platform: { state: 'skipped', version: '0.1.0', tag: 'platform-v0.1.0' },
      },
    })
    const desktop = manifest.releaseUnits.desktop
    if (desktop.state !== 'released') throw new TypeError('Desktop must be released')
    expect(desktop.artifactDigests).toEqual(['sha256:one'])
    expect(manifest.releaseUnits.mobile.state).toBe('blocked')
    expect(manifest.releaseUnits.platform.state).toBe('skipped')
    expect(() => renderReleaseManifest({
      planSequence: 4,
      candidateCommit: 'abc123',
      releaseUnits: {
        desktop: { state: 'blocked', version: '0.2.0', tag: 'gestalt-v0.2.0', reason: '' },
        mobile: { state: 'released', version: '0.1.1', tag: 'mobile-v0.1.1', workflowRun: 'https://github.com/owner/repo/releases/tag/mobile-v0.1.1' },
        platform: { state: 'skipped', version: '0.1.0', tag: 'platform-v0.1.0' },
      },
    })).toThrow()
  })
})

describe('release artifact provenance', () => {
  const candidate = '0123456789abcdef0123456789abcdef01234567'
  const run = {
    id: 123,
    repository: { full_name: 'gestaltrun/deepseek-harness-gestalt' },
    path: '.github/workflows/mobile-release.yml',
    status: 'completed',
    conclusion: 'failure',
    head_sha: '1123456789abcdef0123456789abcdef01234567',
    html_url: 'https://github.com/gestaltrun/deepseek-harness-gestalt/actions/runs/123',
  }
  const jobs = {
    jobs: [{ name: 'mobile / Record Mobile channel evidence', status: 'completed', conclusion: 'success' }],
  }
  const artifactName = `mobile-release-channel-candidate-${candidate}`
  const artifacts = {
    artifacts: [{
      id: 456,
      name: artifactName,
      expired: false,
      workflow_run: { id: run.id, head_sha: run.head_sha },
    }],
  }

  it('accepts a failed caller run only when its named producer and artifact succeeded', () => {
    expect(validatePriorReleaseRun(run, jobs, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt',
      trustedWorkflowHeadCommits: [run.head_sha],
      allowedWorkflows: ['.github/workflows/mobile-release.yml'],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toMatchObject({ workflowRun: run.html_url, workflowHead: run.head_sha, artifactName })
    expect(() => validatePriorReleaseRun({ ...run, head_sha: candidate }, jobs, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toThrow('trusted master history')
    expect(validatePriorReleaseRun({ ...run, head_sha: candidate }, jobs, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [candidate], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toMatchObject({ workflowHead: candidate })
    expect(() => validatePriorReleaseRun(run, jobs, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toThrow('trusted master history')
    expect(() => validatePriorReleaseRun({ ...run, head_sha: 'master' }, jobs, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toThrow('full commit id')
    expect(() => validatePriorReleaseRun(run, {
      jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }],
    }, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [run.head_sha], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toThrow('producing job')
    expect(() => validatePriorReleaseRun(run, jobs, {
      artifacts: [{ ...artifacts.artifacts[0], expired: true }],
    }, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [run.head_sha], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toThrow('named successful artifact')
    expect(() => validatePriorReleaseRun({ ...run, path: '.github/workflows/other.yml' }, jobs, artifacts, {
      repository: 'gestaltrun/deepseek-harness-gestalt', trustedWorkflowHeadCommits: [run.head_sha], allowedWorkflows: [run.path],
      artifactProducers: [{ artifactName, producerJob: 'Record Mobile channel evidence' }],
    })).toThrow('workflow')
  })

  it('binds signed artifact digests and optional TestFlight evidence to the plan', () => {
    const manifest = {
      version: 1,
      surface: 'mobile',
      candidateCommit: candidate,
      planPath: 'product-releases/0001.json',
      productVersion: '0.1.1',
      buildNumber: 6,
      artifactDigests: { 'Gestalt.apk': `sha256:${'a'.repeat(64)}`, 'Gestalt.ipa': `sha256:${'b'.repeat(64)}` },
      testFlight: { buildNumber: 6, workflowRun: run.html_url },
    }
    expect(validateReleaseArtifactManifest(manifest, {
      surface: 'mobile', candidateCommit: candidate, planPath: 'product-releases/0001.json', productVersion: '0.1.1', buildNumber: 6,
    }, manifest.artifactDigests)).toMatchObject({ testFlight: { buildNumber: 6 } })
    expect(() => validateReleaseArtifactManifest(manifest, {
      surface: 'mobile', candidateCommit: candidate, planPath: 'product-releases/0001.json', productVersion: '0.1.1', buildNumber: 6,
    }, { ...manifest.artifactDigests, 'Gestalt.apk': `sha256:${'c'.repeat(64)}` })).toThrow('digests')
    expect(() => validateReleaseArtifactManifest({ ...manifest, candidateCommit: '1123456789abcdef0123456789abcdef01234567' }, {
      surface: 'mobile', candidateCommit: candidate, planPath: 'product-releases/0001.json', productVersion: '0.1.1', buildNumber: 6,
    }, manifest.artifactDigests)).toThrow('candidate')
  })
})

type TestReleases = { desktop: 'none' | 'patch' | 'minor' | 'major'; mobile: 'none' | 'patch' | 'minor' | 'major'; platform: 'none' | 'patch' | 'minor' | 'major' }

function intent(id: string, releases: TestReleases) {
  return parseReleaseIntent(intentValue(id, releases), `${id}.json`)
}

function intentValue(id: string, releases: TestReleases = { desktop: 'patch', mobile: 'none', platform: 'none' }) {
  return {
    version: 1,
    id,
    summary: { en: `Summary for ${id}.`, zh: `${id} 的发布摘要。` },
    releases,
    compatibilityExceptions: [],
  }
}

function jsonRecord(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected JSON object')
  return value as Record<string, unknown>
}

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-product-release-'))
  const manifests = [
    ['apps/desktop', { name: '@deepseek-ai/dsh-desktop', version: '0.1.0', dependencies: { '@fixture/shared': 'workspace:^' } }],
    ['apps/mobile', { name: '@deepseek-ai/dsh-mobile', version: '0.1.0', dependencies: { '@fixture/shared': 'workspace:^', '@fixture/wire': 'workspace:^' } }],
    ['apps/platform', { name: '@deepseek-ai/dsh-platform', version: '0.1.0', dependencies: { '@fixture/wire': 'workspace:^' } }],
    ['packages/shared/runtime', { name: '@fixture/shared', version: '0.0.1' }],
    ['packages/wire/protocol', { name: '@fixture/wire', version: '0.0.1' }],
  ] as const
  for (const [directory, manifest] of manifests) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  await writeFile(join(root, 'apps/mobile/release.json'), '{\n  "version": 1,\n  "buildNumber": 5\n}\n')
  await mkdir(join(root, 'product-releases'), { recursive: true })
  return root
}

async function plannedMobileRelease(root: string) {
  const state = { version: 1 as const, nextSequence: 1, consumedIntentIds: [] }
  const plan = await aggregateProductRelease(root, [
    intent('planned-mobile', { desktop: 'none', mobile: 'patch', platform: 'none' }),
  ], state)
  return { state, plan }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}
