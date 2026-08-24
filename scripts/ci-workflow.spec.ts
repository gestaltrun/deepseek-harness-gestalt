import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js'
const evidenceAfterPreflight = "needs.preflight.result == 'success'"
const masterFallback = "(github.event_name != 'push' || needs.preflight.outputs.proof-reused != 'true')"

describe('CI workflow', () => {
  it('scopes Mobile signing secrets to their consuming steps', () => {
    const workflow = loadWorkflow('.github/workflows/mobile-release.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('mobile-release workflow must define jobs')
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(Object.values(isRecord(job.env) ? job.env : {}).some(value => String(value).includes('secrets.')))
        .toBe(false)
    }
    const android = workflow.jobs.android
    const ios = workflow.jobs.ios
    if (!isRecord(android) || !Array.isArray(android.steps) || !isRecord(ios) || !Array.isArray(ios.steps)) {
      throw new TypeError('mobile-release workflow must define Android and iOS steps')
    }
    const androidBuild = (android.steps as unknown[])
      .find(step => isRecord(step) && step.name === 'Build and verify signed APK')
    const iosBuild = (ios.steps as unknown[])
      .find(step => isRecord(step) && step.name === 'Build signed App Store candidate')
    const upload = (ios.steps as unknown[])
      .find(step => isRecord(step) && step.name === 'Upload TestFlight')
    expect(androidBuild).toMatchObject({ env: {
      ANDROID_KEYSTORE_BASE64: '${{ secrets.ANDROID_KEYSTORE_BASE64 }}',
      ANDROID_KEYSTORE_PASSWORD: '${{ secrets.ANDROID_KEYSTORE_PASSWORD }}',
      ANDROID_KEY_ALIAS: '${{ secrets.ANDROID_KEY_ALIAS }}',
      ANDROID_KEY_PASSWORD: '${{ secrets.ANDROID_KEY_PASSWORD }}',
    } })
    expect(iosBuild).toMatchObject({ env: { APPLE_TEAM_ID: '${{ secrets.APPLE_TEAM_ID }}' } })
    expect(upload).toMatchObject({ env: {
      APPLE_ID: '${{ secrets.APPLE_ID }}',
      APPLE_APP_SPECIFIC_PASSWORD: '${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}',
    } })
  })

  it('rejects runner-only contexts before job construction', () => {
    expect(() => {
      assertJobConstructionContexts({
        jobs: {
          invalid: {
            env: {
              CONFIG: '${{ runner.temp }}/config.json',
            },
          },
        },
      }, 'invalid.yml')
    }).toThrow('invalid.yml job invalid env CONFIG uses runner context before a runner exists')

    for (const file of readdirSync(resolve(root, '.github/workflows'))) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
      assertJobConstructionContexts(loadWorkflow(`.github/workflows/${file}`), file)
    }
  })

  it('validates PR metadata, generated state, and the CI plan before admitting evidence jobs', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const preflight = workflowJob(workflow, 'preflight')
    const preflightPlan = workflowJob(workflow, 'preflight-plan')
    const preflightGenerated = workflowJob(workflow, 'preflight-generated')
    if (!Array.isArray(preflight.steps) || !Array.isArray(preflightPlan.steps)
      || !Array.isArray(preflightGenerated.steps) || !isRecord(workflow.jobs)) {
      throw new TypeError('CI workflow must define preflight worker steps and jobs')
    }
    const preflightSteps = preflightPlan.steps as unknown[]
    const generatedSteps = preflightGenerated.steps as unknown[]

    expect(preflight).toMatchObject({
      name: 'preflight',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 1,
      needs: ['preflight-plan', 'preflight-generated'],
      if: 'always()',
      outputs: {
        level: '${{ needs.preflight-plan.outputs.level }}',
        lanes: '${{ needs.preflight-plan.outputs.lanes }}',
        'affected-areas': '${{ needs.preflight-plan.outputs.affected-areas }}',
        'affected-packages': '${{ needs.preflight-plan.outputs.affected-packages }}',
        'changed-sources': '${{ needs.preflight-plan.outputs.changed-sources }}',
        'escalation-reasons': '${{ needs.preflight-plan.outputs.escalation-reasons }}',
        'evidence-key': '${{ needs.preflight-plan.outputs.evidence-key }}',
      },
    })
    expect(preflight.steps).toContainEqual(expect.objectContaining({
      name: 'Admit evidence lanes',
      env: {
        PLAN_RESULT: '${{ needs.preflight-plan.result }}',
        GENERATED_RESULT: '${{ needs.preflight-generated.result }}',
      },
    }))
    expect(preflightGenerated).toMatchObject({
      name: 'preflight / generated / ${{ matrix.partition }}',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 2,
      env: { DSH_GATE_CONCURRENCY: '4' },
      strategy: {
        'fail-fast': false,
        matrix: {
          include: [
            { partition: 'core', command: 'check:ci:preflight:core' },
            { partition: 'cordis', command: 'check:ci:preflight:cordis' },
            { partition: 'docs', command: 'check:ci:preflight:docs' },
            { partition: 'graphs', command: 'check:ci:preflight:graphs' },
          ],
        },
      },
    })
    expect(preflightSteps).toContainEqual({
      name: 'Validate GitHub Actions workflows',
      uses: 'docker://rhysd/actionlint:1.7.12',
      with: { args: '-color' },
    })
    const metadata = preflightSteps.find(
      step => isRecord(step) && step.name === 'Validate pull request metadata',
    )
    if (!isRecord(metadata) || !isRecord(metadata.env)) {
      throw new TypeError('preflight metadata step must define an environment')
    }
    expect(metadata.env.DSH_REQUIRED_PR_AREAS).toBe('${{ steps.plan.outputs.affected_areas }}')
    const planner = preflightSteps.find(step => isRecord(step) && step.name === 'Compute CI plan')
    if (!isRecord(planner) || typeof planner.run !== 'string') {
      throw new TypeError('preflight planner step must define a command')
    }
    expect(planner.run).toContain(
      'pnpm --silent run ci:plan --event "$GITHUB_EVENT_NAME" --readiness "$READINESS" --base "$BASE_SHA" --head "$HEAD_SHA"',
    )
    expect(planner.run).toContain('tee "$RUNNER_TEMP/ci-evidence/plan.json"')
    expect(preflightSteps.some(step => isRecord(step) && step.name === 'Validate pull request metadata')).toBe(true)
    expect(generatedSteps.some(step => isRecord(step) && step.name === 'Validate generated state and repository constraints')).toBe(true)
    expect(preflightSteps.some(step => isRecord(step) && step.id === 'plan' && step.name === 'Compute CI plan')).toBe(true)
    const planUpload = preflightSteps.find(step => isRecord(step) && step.name === 'Publish CI plan')
    expect(planUpload).toEqual({
      name: 'Publish CI plan',
      if: 'always()',
      uses: 'actions/upload-artifact@v7',
      with: {
        name: 'ci-plan',
        path: '${{ runner.temp }}/ci-evidence/*.json',
        'if-no-files-found': 'warn',
        'retention-days': 30,
      },
    })

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (['preflight-plan', 'preflight-generated', 'preflight'].includes(jobName)) continue
      if (!isRecord(job)) throw new TypeError(`CI job ${jobName} must be an object`)
      const needs = typeof job.needs === 'string' ? [job.needs] : job.needs
      expect(needs, `${jobName} must wait for preflight`).toContain('preflight')
      if (!['all-checks-passed', 'candidate-verdict', 'master-verdict'].includes(jobName)) {
        expect(job.if, `${jobName} must not run after invalid preflight input`)
          .toContain(evidenceAfterPreflight)
      }
    }
  })

  it('publishes machine-readable gate evidence from every run-gates lane', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')
    const expected = new Map([
      ['node-24', 'ci-gates-static'],
      ['node-24-coverage', 'ci-gates-coverage'],
      ['node-24-consumers', 'ci-gates-consumers'],
      ['node-compat', 'ci-gates-node-${{ matrix.node }}'],
      ['windows-native-core', 'ci-gates-windows-native-core'],
      ['windows-native-coverage-exempt', 'ci-gates-windows-native-coverage-exempt'],
      ['windows-native-coverage', 'ci-gates-windows-native-coverage'],
      ['windows-native-static', 'ci-gates-windows-native-static'],
    ])
    for (const [jobId, artifactName] of expected) {
      const job = workflow.jobs[jobId]
      if (!isRecord(job) || !Array.isArray(job.steps)) throw new TypeError(`${jobId} must define steps`)
      const steps = job.steps as unknown[]
      const command = steps.find(step =>
        isRecord(step)
        && isRecord(step.env)
        && typeof step.env.DSH_CI_REPORT_PATH === 'string')
      const upload = steps.find(step =>
        isRecord(step)
        && step.uses === 'actions/upload-artifact@v7'
        && isRecord(step.with)
        && step.with.name === artifactName)

      expect(command, `${jobId} must select a gate report path`).toBeDefined()
      expect(upload, `${jobId} must publish its gate report`).toMatchObject({ if: 'always()' })
    }
  })

  it('keeps hosted cache producer and consumers on one versioned key contract', () => {
    const producer = loadWorkflow('.github/workflows/ci-cache-producer.yml')
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(producer.on) || !isRecord(producer.env) || !isRecord(producer.jobs)
      || !isRecord(workflow.env) || !isRecord(workflow.jobs)) {
      throw new TypeError('cache producer and CI workflow must define events, environment, and jobs')
    }
    expect(Object.keys(producer.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch'])
    expect(producer.env).toMatchObject({ PRIMARY_NODE_VERSION: '24', PNPM_VERSION: '11.7.0' })
    expect(workflow.env.PNPM_VERSION).toBe('11.7.0')
    const producerJob = workflowJob(producer, 'produce')
    if (!Array.isArray(producerJob.steps) || !isRecord(producerJob.strategy)) {
      throw new TypeError('cache producer must define steps and a platform matrix')
    }
    expect(producerJob.strategy).toMatchObject({
      'fail-fast': false,
      matrix: {
        include: [
          expect.objectContaining({ os: 'Linux', arch: 'X64', runner: 'ubuntu-latest' }),
          expect.objectContaining({ os: 'Windows', arch: 'X64', runner: 'windows-latest' }),
        ],
      },
    })
    const producerSteps = producerJob.steps as unknown[]
    const producerPnpm = producerSteps.find(step => isRecord(step) && step.id === 'pnpm-cache')
    const producerPlaywright = producerSteps.find(step => isRecord(step) && step.id === 'playwright-cache')
    if (!isRecord(producerPnpm) || !isRecord(producerPnpm.with)
      || !isRecord(producerPlaywright) || !isRecord(producerPlaywright.with)) {
      throw new TypeError('cache producer must define pnpm and Playwright cache steps')
    }
    const pnpmKey = 'dsh-${{ runner.os }}-${{ runner.arch }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ env.PNPM_VERSION }}-store-${{ hashFiles(\'pnpm-lock.yaml\') }}'
    const pnpmFallback = 'dsh-${{ runner.os }}-${{ runner.arch }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ env.PNPM_VERSION }}-store-\n'
    const playwrightKey = 'dsh-${{ runner.os }}-${{ runner.arch }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ env.PNPM_VERSION }}-playwright-${{ hashFiles(\'pnpm-lock.yaml\') }}'
    expect(producerPnpm.with).toMatchObject({ key: pnpmKey, 'restore-keys': pnpmFallback })
    expect(producerPlaywright.with).toMatchObject({ key: playwrightKey })
    for (const step of producerSteps) {
      if (!isRecord(step) || !isRecord(step.with) || typeof step.with.path !== 'string') continue
      expect(step.with.path).not.toContain('node_modules')
    }
    expect(producerSteps).toContainEqual(expect.objectContaining({
      name: 'Install dependencies from a clean workspace',
      run: 'pnpm install --frozen-lockfile',
    }))

    const cacheJobs = [producerJob, ...Object.values(workflow.jobs)]
    const powerShellStoreSteps: unknown[] = []
    for (const job of cacheJobs) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue
      for (const step of job.steps as unknown[]) {
        if (isRecord(step) && step.id === 'pnpm-store' && step.shell === 'pwsh') {
          powerShellStoreSteps.push(step)
        }
      }
    }
    expect(powerShellStoreSteps).not.toHaveLength(0)
    for (const step of powerShellStoreSteps) {
      if (!isRecord(step) || typeof step.run !== 'string') {
        throw new TypeError('PowerShell pnpm store setup must define a command')
      }
      const assignment = step.run.indexOf('$env:PNPM_CONFIG_STORE_DIR = $storeRoot')
      const resolution = step.run.indexOf('$storePath = pnpm store path --silent')
      expect(assignment, 'PowerShell must configure the current step before resolving the store').toBeGreaterThan(-1)
      expect(resolution).toBeGreaterThan(assignment)
    }

    for (const jobId of ['node-24', 'node-24-coverage', 'node-24-consumers']) {
      const job = workflowJob(workflow, jobId)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobId} must define steps`)
      const steps = job.steps as unknown[]
      const restore = steps.find(step => isRecord(step) && step.id === 'pnpm-cache')
      if (!isRecord(restore) || !isRecord(restore.with)) throw new TypeError(`${jobId} must restore pnpm cache`)
      expect(restore).toMatchObject({ uses: 'actions/cache/restore@v4' })
      expect(restore.with).toMatchObject({ key: pnpmKey, 'restore-keys': pnpmFallback })
      const command = steps.find(step => isRecord(step)
        && isRecord(step.env)
        && typeof step.env.DSH_CI_REPORT_PATH === 'string')
      if (!isRecord(command) || !isRecord(command.env)) throw new TypeError(`${jobId} must publish gate evidence`)
      expect(command.env.DSH_CI_CACHE_STATUS).toContain('"id":"pnpm-store"')
    }
    for (const jobId of [
      'windows-native-core',
      'windows-native-coverage-shards',
      'windows-native-coverage',
      'windows-native-static',
    ]) {
      const job = workflowJob(workflow, jobId)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobId} must define steps`)
      const restore = (job.steps as unknown[]).find(step => isRecord(step) && step.id === 'pnpm-cache')
      if (!isRecord(restore) || !isRecord(restore.with)) throw new TypeError(`${jobId} must restore pnpm cache`)
      expect(restore.with).toMatchObject({ key: pnpmKey, 'restore-keys': pnpmFallback })
    }
    const consumers = workflowJob(workflow, 'node-24-consumers')
    if (!Array.isArray(consumers.steps)) throw new TypeError('consumer lane must define steps')
    const browserRestore = (consumers.steps as unknown[]).find(step => isRecord(step) && step.id === 'playwright-cache')
    if (!isRecord(browserRestore) || !isRecord(browserRestore.with)) {
      throw new TypeError('consumer lane must restore Playwright cache')
    }
    expect(browserRestore.with.key).toBe(playwrightKey)
  })

  it('runs only selected Draft evidence while keeping ready plans exhaustive', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')
    const draftImpact = workflow.jobs['draft-impact']
    const consumers = workflow.jobs['node-24-consumers']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!isRecord(draftImpact) || !Array.isArray(draftImpact.steps)
      || !isRecord(consumers) || !isRecord(aggregate) || !Array.isArray(aggregate.steps)) {
      throw new TypeError('CI workflow must define Draft impact, consumers, and aggregate jobs')
    }
    expect(draftImpact.if).toBe(
      `${evidenceAfterPreflight} && ${masterFallback} && contains(fromJSON(needs.preflight.outputs.lanes), 'draft-impact')`,
    )
    expect(draftImpact.steps).toContainEqual(expect.objectContaining({
      name: 'Run changed packages and reverse consumers',
      run: 'pnpm ci:impact --base "$BASE_SHA" --head "$HEAD_SHA"',
    }))
    expect(consumers.if).toBe(
      `${evidenceAfterPreflight} && ${masterFallback} && contains(fromJSON(needs.preflight.outputs.lanes), 'consumers')`,
    )
    const verdict = (aggregate.steps as unknown[]).find(step =>
      isRecord(step) && step.name === 'Validate selected required jobs')
    if (!isRecord(verdict) || typeof verdict.run !== 'string') {
      throw new TypeError('aggregate verdict must define a command')
    }
    expect(verdict.run).toContain("level === 'exhaustive'")
    expect(verdict.run).toContain("lanes.includes('draft-impact')")
    expect(verdict.run).toContain("lanes.includes('static')")
    expect(verdict.run).toContain("lanes.includes('consumers')")
  })

  it('proves the Merge Queue candidate tree through one fail-closed verdict', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) {
      throw new TypeError('CI workflow must define event routing and jobs')
    }
    const preflightPlan = workflowJob(workflow, 'preflight-plan')
    const candidate = workflowJob(workflow, 'candidate-verdict')
    if (!Array.isArray(preflightPlan.steps) || !Array.isArray(candidate.needs)
      || !Array.isArray(candidate.steps)) {
      throw new TypeError('candidate workflow must define preflight and verdict structure')
    }
    const preflightSteps = preflightPlan.steps as unknown[]
    const candidateSteps = candidate.steps as unknown[]
    const candidateNeeds = (candidate.needs as unknown[]).filter(
      (job): job is string => typeof job === 'string',
    )
    if (candidateNeeds.length !== candidate.needs.length) {
      throw new TypeError('candidate dependencies must be job id strings')
    }

    expect(Object.keys(workflow.on).sort()).toEqual(['merge_group', 'pull_request', 'push'])
    const planner = preflightSteps.find(step => isRecord(step) && step.name === 'Compute CI plan')
    const metadata = preflightSteps.find(step => isRecord(step) && step.name === 'Validate pull request metadata')
    expect(planner).toMatchObject({
      env: {
        BASE_SHA: "${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || (github.event_name == 'push' && github.event.before || github.event.pull_request.base.sha) }}",
        HEAD_SHA: "${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || (github.event_name == 'push' && github.sha || github.event.pull_request.head.sha) }}",
        READINESS: "${{ github.event_name != 'pull_request' && 'ready' || (github.event.pull_request.draft && 'draft' || 'ready') }}",
      },
    })
    expect(metadata).toMatchObject({ if: "github.event_name == 'pull_request'" })

    expect(candidate).toMatchObject({
      name: 'candidate verdict',
      'runs-on': 'ubuntu-latest',
      if: "always() && github.event_name == 'merge_group'",
    })
    expect(candidateNeeds).toEqual([
      'preflight',
      'draft-impact',
      'node-24',
      'node-24-coverage',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows',
      'windows-native-verdict',
      'electron-runtime-e2e-macos',
    ])
    const verdict = candidateSteps.find(step => isRecord(step) && step.name === 'Validate the exhaustive candidate tree')
    if (!isRecord(verdict) || typeof verdict.run !== 'string') {
      throw new TypeError('candidate verdict must define its fail-closed command')
    }
    expect(verdict.run).toContain("level !== 'exhaustive'")
    for (const job of candidateNeeds.filter(job => job !== 'draft-impact')) {
      expect(verdict.run, `candidate verdict must require ${job}`).toContain(`'${job}'`)
    }
    expect(verdict.run).toContain("results[job]?.result !== 'success'")
    const attestationCompletion = candidateSteps.find(step => isRecord(step)
      && step.name === 'Complete candidate attestation')
    if (!isRecord(attestationCompletion) || typeof attestationCompletion.run !== 'string') {
      throw new TypeError('candidate verdict must complete its attestation through the checked command')
    }
    const completionIndex = candidateSteps.indexOf(attestationCompletion)
    expect(candidateSteps.slice(candidateSteps.indexOf(verdict) + 1, completionIndex)).toEqual(expect.arrayContaining([
      expect.objectContaining({ uses: 'actions/checkout@v6' }),
      expect.objectContaining({ uses: 'pnpm/action-setup@v4' }),
      expect.objectContaining({ uses: 'actions/setup-node@v6' }),
      expect.objectContaining({
        name: 'Install (immutable)',
        run: 'pnpm install --frozen-lockfile',
      }),
    ]))
    expect(attestationCompletion.run).toContain('pnpm --silent ci:attestation complete')
    expect(attestationCompletion.run).not.toContain("node <<'NODE'")
    const attestationUpload = candidateSteps.find(step => isRecord(step)
      && step.name === 'Publish candidate attestation')
    expect(attestationUpload).toMatchObject({
      uses: 'actions/upload-artifact@v7',
      with: {
        name: '${{ steps.attestation.outputs.artifact_name }}',
        'if-no-files-found': 'error',
      },
    })
  })

  it('reuses an exact candidate proof on master and falls back exhaustively otherwise', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')
    const preflight = workflowJob(workflow, 'preflight')
    const preflightPlan = workflowJob(workflow, 'preflight-plan')
    const smoke = workflowJob(workflow, 'master-smoke')
    const verdict = workflowJob(workflow, 'master-verdict')
    if (!Array.isArray(preflightPlan.steps) || !Array.isArray(verdict.needs)
      || !Array.isArray(verdict.steps)) {
      throw new TypeError('master proof workflow must define preflight and verdict structure')
    }
    expect(preflight.outputs).toMatchObject({
      'proof-tree': '${{ needs.preflight-plan.outputs.proof-tree }}',
      'proof-key': '${{ needs.preflight-plan.outputs.proof-key }}',
      'proof-reused': '${{ needs.preflight-plan.outputs.proof-reused }}',
      'proof-reason': '${{ needs.preflight-plan.outputs.proof-reason }}',
      'proof-source-run-id': '${{ needs.preflight-plan.outputs.proof-source-run-id }}',
    })
    const preflightSteps = preflightPlan.steps as unknown[]
    expect(preflightSteps).toContainEqual(expect.objectContaining({
      name: 'Resolve reusable candidate proof',
      id: 'reuse',
      if: "github.event_name == 'push'",
    }))
    for (const jobName of [
      'node-24',
      'node-24-coverage',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows',
      'windows-native-core',
      'windows-native-coverage',
      'windows-native-static',
      'windows-native-verdict',
      'electron-runtime-e2e-macos',
    ]) {
      const job = workflowJob(workflow, jobName)
      expect(job.if, `${jobName} must skip only on exact proof reuse`).toContain(masterFallback)
    }
    expect(smoke).toMatchObject({
      name: 'master reuse smoke',
      if: `${evidenceAfterPreflight} && github.event_name == 'push'`,
      'runs-on': 'ubuntu-latest',
    })
    expect(verdict).toMatchObject({
      name: 'master evidence verdict',
      if: "always() && github.event_name == 'push'",
      'runs-on': 'ubuntu-latest',
    })
    const masterNeeds = (verdict.needs as unknown[]).filter(
      (job): job is string => typeof job === 'string',
    )
    expect(masterNeeds).toEqual(expect.arrayContaining([
      'preflight',
      'master-smoke',
      'windows-native-verdict',
      'electron-runtime-e2e-macos',
    ]))
    const decision = (verdict.steps as unknown[]).find(step => isRecord(step)
      && step.name === 'Validate proof reuse or exhaustive fallback')
    if (!isRecord(decision) || typeof decision.run !== 'string') {
      throw new TypeError('master verdict must define its decision command')
    }
    expect(decision.run).toContain("process.env.PROOF_REUSED === 'true'")
    expect(decision.run).toContain("? ['preflight', 'master-smoke']")
    expect(decision.run).toContain("results[job]?.result !== 'success'")
  })

  it('makes optional dependencies mandatory for master standby installs', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(workflow.env)) throw new TypeError('ci-master workflow must define environment variables')
    if (!isRecord(workflow.jobs)) throw new TypeError('ci-master workflow must define jobs')

    expect(workflow.env.PNPM_CONFIG_OPTIONAL).toBe('true')
    for (const jobName of [
      'standby-linux-smoke',
      'standby-windows-smoke',
      'standby-linux-exhaustive',
      'standby-windows-exhaustive',
    ]) {
      const job = workflow.jobs[jobName]
      if (!isRecord(job) || !Array.isArray(job.steps)) {
        throw new TypeError(`ci-master workflow must define ${jobName} steps`)
      }
      const install = (job.steps as unknown[]).find(
        step => isRecord(step) && step.name === 'Install (immutable)',
      )
      expect(install, `${jobName} must rebuild persistent node_modules with optional dependencies`).toMatchObject({
        env: { PNPM_CONFIG_FETCH_TIMEOUT: '600000' },
        run: 'pnpm install --frozen-lockfile',
      })
      const payloads = (job.steps as unknown[]).find(
        step => isRecord(step) && step.name === 'Verify current platform payloads',
      )
      expect(payloads, `${jobName} must execute the installed native payloads`).toMatchObject({
        run: 'pnpm run verify-platform-payloads',
      })
      if (jobName.includes('windows')) {
        const runtime = (job.steps as unknown[]).find(
          step => isRecord(step) && step.name === 'Ensure Windows CI native runtime',
        )
        expect(runtime, `${jobName} must provision the signed MSVC runtime before native gates`).toMatchObject({
          shell: 'pwsh',
          run: './scripts/ensure-windows-ci-runtime.ps1',
        })
        expect(job.steps.indexOf(install)).toBeLessThan(job.steps.indexOf(runtime))
        expect(job.steps.indexOf(runtime)).toBeLessThan(job.steps.indexOf(payloads))
      }
    }
  })

  it('pins ordinary installs to current-platform optional payloads', () => {
    const workspace = yaml.load(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'))
    if (!isRecord(workspace)) throw new TypeError('pnpm-workspace.yaml must define a mapping')

    expect(workspace.supportedArchitectures).toEqual({
      os: ['current'],
      cpu: ['current', 'wasm32'],
      libc: ['current'],
    })
  })

  it('keeps bounded push smokes separate from exhaustive failover readiness drills', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const smokeCases = [
      ['standby-linux-smoke', 'pnpm run check:ci:standby-linux-smoke'],
      ['standby-windows-smoke', 'pnpm run check:ci:standby-windows-smoke'],
    ] as const
    const exhaustiveCases = [
      ['standby-linux-exhaustive', 'pnpm run check:ci:linux-primary'],
      ['standby-windows-exhaustive', 'pnpm run check:ci:windows-complete'],
    ] as const

    for (const [jobName, command] of smokeCases) {
      const job = workflowJob(workflow, jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(job).toMatchObject({
        if: "github.event_name == 'push' && github.ref == 'refs/heads/master'",
        'timeout-minutes': 20,
      })
      expect(job.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Rebuild workspace state', run: 'git clean -ffdx' }),
        expect.objectContaining({ run: command }),
        expect.objectContaining({ if: 'always()', uses: 'actions/upload-artifact@v7' }),
      ]))
    }

    for (const [jobName, command] of exhaustiveCases) {
      const job = workflowJob(workflow, jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(job).toMatchObject({
        if: "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.suite == 'standby-exhaustive')",
        'timeout-minutes': 120,
      })
      expect(job.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Rebuild workspace state', run: 'git clean -ffdx' }),
        expect.objectContaining({ if: 'always()', uses: 'actions/upload-artifact@v7' }),
      ]))
      const runStep = (job.steps as unknown[]).find(step => isRecord(step) && step.run === command)
      if (!isRecord(runStep) || !isRecord(runStep.env)) {
        throw new TypeError(`${jobName} must define the exhaustive command environment`)
      }
      expect(runStep.env.DSH_CI_FAILURE_CLASSIFICATION).toBe('failover-readiness')
      if (jobName === 'standby-linux-exhaustive') {
        expect(runStep.env.DSH_ARCHIVE_BASE_REF).toBe('HEAD^')
      }
    }
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const files = [
      '.github/workflows/ci.yml',
      '.github/workflows/ci-master.yml',
      '.github/workflows/ci-cache-producer.yml',
    ]
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: {
          dest: jobName.startsWith('windows-native-') && jobName !== 'windows-native-coverage'
            ? nativeWindowsPnpmDestination
            : runnerPrivatePnpmDestination,
        },
      })
      if (jobName.startsWith('windows-native-') && jobName !== 'windows-native-coverage') {
        expect(step).not.toMatchObject({ with: { standalone: true } })
      }
    }
  })

  it('fetches full history in every lane that executes the coverage inventory', () => {
    const workflows = [
      loadWorkflow('.github/workflows/ci.yml'),
      loadWorkflow('.github/workflows/ci-master.yml'),
    ]
    // Each of these aggregates expands to coverageGates() in
    // scripts/run-gates.ts. The release-notes test inside them resolves the
    // pinned manifest range through the Git graph, which the default depth-1
    // checkout cannot satisfy. Job ids are pinned so a renamed or
    // wrapper-scripted lane cannot leave the full-history set unnoticed.
    const coverageCommands = new Set([
      'pnpm run check:ci',
      'pnpm run check:ci:coverage',
      'pnpm run check:ci:linux-primary',
      'pnpm run check:ci:windows-complete',
      'pnpm run test:coverage:partitioned',
    ])
    const coverageJobIds = [
      'consolidated-runner-benchmark',
      'node-24-coverage',
      'serial-macos',
      'standby-linux-exhaustive',
      'standby-windows-exhaustive',
      'windows-native-coverage-shards',
    ] as const
    const coverageJobs = workflows.flatMap((workflow) => {
      if (!isRecord(workflow.jobs)) throw new TypeError('CI workflows must define jobs')
      return Object.entries(workflow.jobs).filter(([, job]) =>
        isRecord(job) && Array.isArray(job.steps) && job.steps.some(
          step => isRecord(step) && typeof step.run === 'string' && coverageCommands.has(step.run.trim()),
        ))
    })
    expect(coverageJobs.map(([jobName]) => jobName).sort()).toEqual([...coverageJobIds])
    for (const [jobName, job] of coverageJobs) {
      if (!isRecord(job) || !Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      const checkouts = job.steps.filter(
        step => isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
      )
      expect(checkouts.length, `${jobName} must check out the repository`).toBeGreaterThan(0)
      for (const checkout of checkouts) {
        expect(
          checkout,
          `${jobName} must fetch full history for the release-notes coverage test`,
        ).toMatchObject({ with: { 'fetch-depth': 0 } })
      }
    }
  })

  it('fetches full history for the Sandbox macOS unit parity suite', () => {
    const workflow = loadWorkflow('.github/workflows/sandbox.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs['sandbox-e2e'])) {
      throw new TypeError('Sandbox workflow must define sandbox-e2e')
    }
    const job = workflow.jobs['sandbox-e2e']
    if (!Array.isArray(job.steps)) throw new TypeError('sandbox-e2e must define steps')
    const checkout = (job.steps as unknown[]).find(
      step => isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )

    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })
  })

  it('keeps required Wine, one partitioned native Windows verdict, and tiered master standby drills', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs.windows)
      || !isRecord(workflow.jobs['windows-native-core'])
      || !isRecord(workflow.jobs['windows-native-coverage-shards'])
      || !isRecord(workflow.jobs['windows-native-coverage-exempt'])
      || !isRecord(workflow.jobs['windows-native-coverage'])
      || !isRecord(workflow.jobs['windows-native-static'])
      || !isRecord(workflow.jobs['windows-native-verdict'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['all-checks-passed'])
      || !isRecord(masterWorkflow.jobs)
      || !isRecord(masterWorkflow.jobs['wine-apt-cache'])
      || !isRecord(masterWorkflow.jobs['standby-windows-smoke'])
      || !isRecord(masterWorkflow.jobs['standby-windows-exhaustive'])) {
      throw new TypeError('CI workflow must define Wine, native Windows partitions and verdict, Linux workers, and all-checks-passed; ci-master must define Wine cache and tiered Windows standby drills')
    }

    const windows = workflow.jobs.windows
    const windowsNativeCore = workflow.jobs['windows-native-core']
    const windowsNativeCoverageShards = workflow.jobs['windows-native-coverage-shards']
    const windowsNativeCoverageExempt = workflow.jobs['windows-native-coverage-exempt']
    const windowsNativeCoverage = workflow.jobs['windows-native-coverage']
    const windowsNativeStatic = workflow.jobs['windows-native-static']
    const windowsNativeVerdict = workflow.jobs['windows-native-verdict']
    const wineAptCache = masterWorkflow.jobs['wine-apt-cache']
    const standbyWindowsSmoke = masterWorkflow.jobs['standby-windows-smoke']
    const standbyWindowsExhaustive = masterWorkflow.jobs['standby-windows-exhaustive']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(windows.steps)
      || !Array.isArray(aggregate.needs)
      || !isRecord(windowsNativeCore.env)
      || !isRecord(windowsNativeCoverageShards.env)
      || !isRecord(windowsNativeCoverageExempt.env)
      || !isRecord(windowsNativeStatic.env)
      || !Array.isArray(windowsNativeVerdict.needs)
      || !isRecord(node24.env)
      || !isRecord(node24Coverage.env)
      || !isRecord(node24Consumers.env)) {
      throw new TypeError('CI jobs must define the expected steps, environments, and aggregate dependencies')
    }
    const commandSteps = windows.steps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))

    // Required PR job: Wine on ubuntu-latest, runs wine-windows-gates.sh.
    expect(windows['runs-on']).toBe('ubuntu-latest')
    expect(windows.name).toBe('windows node 24 / wine blocking')
    expect(windows.if).toContain(evidenceAfterPreflight)
    expect(commandSteps.some(step => step.run.includes('wine-windows-gates.sh'))).toBe(true)

    const nativePartitions = [windowsNativeCore, windowsNativeCoverageExempt, windowsNativeStatic]
    for (const partition of nativePartitions) {
      expect(typeof partition['runs-on']).toBe('string')
      expect(partition['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(partition['runs-on']).not.toContain('DSH_CI_FAILOVER_LINUX')
      expect(partition['runs-on']).toContain('dsh-win-ci')
      expect(partition['runs-on']).toContain('windows-latest')
      expect(partition.if).toContain(evidenceAfterPreflight)
      expect(partition['timeout-minutes']).toBe(20)
    }
    expect(windowsNativeCore['runs-on']).toContain('windows-latest')
    expect(windowsNativeStatic['runs-on']).toContain('windows-latest')
    expect(windowsNativeCoverage['runs-on']).toBe('ubuntu-latest')
    expect(windowsNativeCoverage['timeout-minutes']).toBe(5)
    expect(windowsNativeCoverageShards['runs-on']).toContain('windows-latest')
    expect(windowsNativeCoverageShards.strategy).toMatchObject({
      'fail-fast': false,
      matrix: {
        include: [
          { shard: 1, indexes: '1,2,3,4' },
          { shard: 2, indexes: '5,6,7,8' },
        ],
      },
    })
    expect(windowsNativeCoverageShards.env).toMatchObject({
      DSH_COVERAGE_EXEMPT_HEAVY: '1',
      DSH_COVERAGE_PARTITIONS: '8',
      DSH_COVERAGE_PARTITION_CONCURRENCY: '2',
      DSH_COVERAGE_PARTITION_INDEXES: '${{ matrix.indexes }}',
      DSH_COVERAGE_PRESERVE_BLOBS: '1',
      DSH_TEST_REQUIRE_PWSH: '1',
    })
    expect(windowsNativeCoverageExempt.env).toMatchObject({
      DSH_COVERAGE_MAX_WORKERS: '4',
      DSH_COVERAGE_TEST_TIMEOUT_MS: '30000',
    })
    expect(windowsNativeCoverage.needs).toEqual(['preflight', 'windows-native-coverage-shards'])
    expect(windowsNativeCoverage.if).toBe(
      `${evidenceAfterPreflight} && ${masterFallback} && needs.windows-native-coverage-shards.result == 'success' && contains(fromJSON(needs.preflight.outputs.lanes), 'windows-native')`,
    )
    expect(windowsNativeVerdict.needs).toEqual([
      'preflight',
      'windows-native-core',
      'windows-native-coverage-shards',
      'windows-native-coverage-exempt',
      'windows-native-coverage',
      'windows-native-static',
    ])
    expect(windowsNativeVerdict['runs-on']).toBe('ubuntu-latest')
    expect(windowsNativeVerdict.name).toBe('windows node 24 / native verdict')
    const nativeCommands = [...nativePartitions, windowsNativeCoverage].map((partition) => {
      if (!Array.isArray(partition.steps)) throw new TypeError('native partition must define steps')
      return partition.steps
        .filter((step): step is Record<string, unknown> & { run: string } => isRecord(step) && typeof step.run === 'string')
        .map(step => step.run)
    }).flat()
    expect(nativeCommands).toEqual(expect.arrayContaining([
      'pnpm run check:ci:windows-native-core',
      'pnpm run check:ci:windows-native-coverage-exempt',
      'pnpm run check:ci:windows-native-coverage-merge',
      'pnpm run check:ci:windows-native-static',
    ]))

    // wine-apt-cache: master-only, seeds the Wine apt cache, lives in ci-master.
    expect(wineAptCache.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(wineAptCache['runs-on']).toBe('ubuntu-latest')

    // Every master push proves a bounded Windows failover smoke. The complete
    // serial reference remains available on the daily/manual cadence.
    expect(standbyWindowsSmoke).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/master'",
      name: 'standby smoke / windows (self-hosted)',
      'runs-on': ['self-hosted', 'dsh-win-ci', 'windows'],
      'timeout-minutes': 20,
    })
    expect(standbyWindowsExhaustive).toMatchObject({
      if: "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.suite == 'standby-exhaustive')",
      name: 'standby exhaustive / windows (self-hosted)',
      'runs-on': ['self-hosted', 'dsh-win-ci', 'windows'],
      'timeout-minutes': 120,
    })

    // Aggregate: Wine is required; the independent native verdict is observational.
    expect(aggregate.needs).toContain('windows')
    expect(aggregate.needs).not.toContain('windows-native-verdict')
    expect(aggregate.needs).not.toContain('windows-native-core')
    expect(aggregate.needs).not.toContain('windows-native-coverage')
    expect(aggregate.needs).not.toContain('windows-native-static')
    expect(aggregate.needs).not.toContain('standby-windows-smoke')
    expect(aggregate.needs).not.toContain('standby-windows-exhaustive')
    expect(aggregate.needs).not.toContain('electron-runtime-e2e-macos')

    const macosElectron = workflow.jobs['electron-runtime-e2e-macos']
    if (!isRecord(macosElectron) || !Array.isArray(macosElectron.steps)) {
      throw new TypeError('CI workflow must define electron-runtime-e2e-macos')
    }
    expect(macosElectron.if).toContain(evidenceAfterPreflight)
    expect(macosElectron['runs-on']).toBe('macos-latest')
    expect(macosElectron.name).toBe('macos electron runtime e2e')
    const macosCommands = macosElectron.steps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(macosCommands.map(step => step.run)).toContain('pnpm run test:electron-runtime-e2e')

    // Linux failover is a separate switch: the three required Linux workers
    // and the verdict job resolve their pool through DSH_CI_FAILOVER_LINUX,
    // never the Windows switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
      expect(job['runs-on']).toContain('ubuntu-latest')
      expect(job['runs-on']).not.toContain('dsh-ubuntu-24-04-16core')
    }
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
    expect(String(node24.env.DSH_GATE_CONCURRENCY)).toContain("|| '4'")
    expect(String(node24Coverage.env.DSH_COVERAGE_MAX_WORKERS)).toContain("|| '2'")
    expect(String(node24Coverage.env.DSH_COVERAGE_PARTITION_CONCURRENCY)).toContain("&& '4'")
    expect(String(node24Coverage.env.DSH_COVERAGE_PARTITION_CONCURRENCY)).toContain("|| '2'")
    expect(node24Coverage.env.DSH_COVERAGE_TEST_TIMEOUT_MS).toBe('30000')
    expect(node24Coverage.env.DSH_TEST_REQUIRE_PWSH).toBe('1')
    expect(String(node24Coverage.env.DSH_GATE_CONCURRENCY)).toContain("|| '2'")
    expect(String(node24Consumers.env.DSH_GATE_CONCURRENCY)).toContain("|| '4'")
    expect(String(node24Consumers.env.DSH_SNAPSHOT_MAX_CONCURRENCY)).toContain("|| '8'")
  })

  it('exempts push from cancellation in ci-master, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('ci-master workflow must define jobs and a workflow-level concurrency block')
    }
    if (!isRecord(prWorkflow.jobs)) {
      throw new TypeError('ci workflow must define jobs')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // The PR-only ci.yml still cancels a superseded run on a new push, so a
    // fresh head does not stack a second full 9-job run behind a stale one.
    // Unlike ci-master it has no push carve-out: every PR event supersedes.
    expect(prWorkflow.concurrency).toMatchObject({
      'cancel-in-progress': true,
    })

    // The exact event sets are what keep master-only jobs out of the PR check
    // panel: ci-master triggers only on push(master), the daily schedule, and
    // workflow_dispatch; ci.yml owns PR feedback plus Merge Queue proof.
    // Assert the full sets so losing the wrong event, or gaining an extra one,
    // fails.
    if (!isRecord(workflow.on) || !isRecord(prWorkflow.on)) {
      throw new TypeError('both CI workflows must define on')
    }
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch'])
    expect(Object.keys(prWorkflow.on).sort()).toEqual(['merge_group', 'pull_request', 'push'])

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['standby-linux-smoke', 'standby-windows-smoke']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only; that is what makes the push carve-out safe.
      expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    }

    // What bounds the cost of exempting push: a master push may only carry the
    // cache seeder and the two drills. Any job reachable on push would start
    // accumulating uncancelled runs, so the set is pinned here.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
      "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.suite == 'standby-exhaustive')",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['standby-linux-smoke', 'standby-windows-smoke', 'wine-apt-cache'])

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires one release-shaped Python runtime target in every exhaustive plan', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: `${evidenceAfterPreflight} && ${masterFallback} && contains(fromJSON(needs.preflight.outputs.lanes), 'python-runtime')`,
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64',
        ci: true,
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('DeepSeek e2e workflow', () => {
  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const install = buildSteps.find(step => isRecord(step) && step.name === 'Install (immutable)')
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    const transientAttempts = buildSteps.find(step => isRecord(step) && step.name === 'Publish transient infrastructure attempts')
    if (!isRecord(install) || typeof install.run !== 'string') {
      throw new TypeError('Python wheel builder must define its immutable install command')
    }
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    expect(install.run).toContain('scripts/retry-transient-ci.ts')
    expect(install.run).toContain('install-${{ matrix.target }}.json')
    expect(install.run).toContain('-- pnpm install --frozen-lockfile')
    expect(transientAttempts).toMatchObject({
      if: "always() && runner.os == 'Linux'",
      with: { path: '${{ runner.temp }}/ci-evidence/*.json' },
    })
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Issue lifecycle workflow', () => {
  it('runs the lifecycle job on every PR/review event but gates token and board steps', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    if (!Array.isArray(lifecycleJob.steps)) throw new TypeError('Issue lifecycle job must define steps')

    // This fork enables the Project lifecycle through a repository variable.
    // Once enabled, write-capable review steps remain gated so approved and
    // commented reviews never mint a Project/Issue App token or touch the board.
    expect(lifecycle.on).toHaveProperty('pull_request')
    expect(lifecycle.on).toHaveProperty('pull_request_review')
    expect(lifecycleJob.if).toBe("${{ vars.DSH_ISSUE_PROJECT_LIFECYCLE_ENABLED == 'true' }}")
    // Keep the subscription-type gates: issue-lifecycle does not re-subscribe
    // ready_for_review (issue-policy owns that) and only reacts to submitted
    // review events.
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    const lifecycleSteps: unknown[] = lifecycleJob.steps
    const validationStepIndex = lifecycleSteps.findIndex(
      step => isRecord(step) && step.name === 'Validate project owner',
    )
    const tokenStepIndex = lifecycleSteps.findIndex(
      step => isRecord(step) && step.name === 'Create project token',
    )
    expect(lifecycleSteps[validationStepIndex]).toMatchObject({
      run: 'node .github/issue-management/policy.mjs deployment',
    })
    expect(validationStepIndex).toBeGreaterThanOrEqual(0)
    expect(tokenStepIndex).toBeGreaterThan(validationStepIndex)
    const tokenStep = lifecycleSteps.find(
      step => isRecord(step) && step.name === 'Create project token',
    )
    const handleStep = lifecycleSteps.find(
      step => isRecord(step) && step.name === 'Handle repository event',
    )
    const gated = "${{ github.event_name != 'pull_request_review' || github.event.review.state == 'changes_requested' }}"
    expect(tokenStep).toMatchObject({
      if: gated,
      with: {
        owner: '${{ github.repository_owner }}',
        repositories: '${{ github.event.repository.name }}',
      },
    })
    expect(handleStep).toMatchObject({ if: gated })

    // issue-policy owns PR validation; it is read-only and a real gate.
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('npm release workflows', () => {
  it('keeps publication dispatch-only and pack in the PR workflow', () => {
    // pack stays in the PR/master release workflows so a PR proves the set packs.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(['pack'])
    }

    // publication is workflow_dispatch-only (never a PR check) and keeps the
    // npm-publish environment plus the shared dist-tag group.
    for (const file of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define on and jobs`)
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      const publish = workflow.jobs.publish
      if (!isRecord(publish)) throw new TypeError(`${file} must define a publish job`)
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toMatchObject({ group: 'Release-publish' })
    }
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function assertJobConstructionContexts(workflow: Record<string, unknown>, file: string): void {
  if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job) || !isRecord(job.env)) continue
    for (const [name, value] of Object.entries(job.env)) {
      if (typeof value === 'string' && value.includes('${{ runner.')) {
        throw new TypeError(`${file} job ${jobName} env ${name} uses runner context before a runner exists`)
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
