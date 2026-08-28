/** Deterministic product release intent, impact, version, and evidence planning. */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

export const PRODUCT_RELEASE_UNITS = ['desktop', 'mobile', 'platform'] as const
export type ProductReleaseUnit = typeof PRODUCT_RELEASE_UNITS[number]
export type ReleaseBump = 'none' | 'patch' | 'minor' | 'major'

export interface LocalizedReleaseSummary {
  en: string
  zh: string
}

export interface CompatibilityException {
  releaseUnit: ProductReleaseUnit
  reason: string
}

export interface ReleaseIntent {
  version: 1
  id: string
  summary: LocalizedReleaseSummary
  releases: Record<ProductReleaseUnit, ReleaseBump>
  compatibilityExceptions: CompatibilityException[]
}

export interface ProductReleaseState {
  version: 1
  nextSequence: number
  consumedIntentIds: string[]
}

interface SelectedReleaseUnit {
  selected: true
  previousVersion: string
  version: string
  tag: string
  bump: Exclude<ReleaseBump, 'none'>
  summaries: LocalizedReleaseSummary[]
  buildNumber?: number
}

interface SkippedReleaseUnit {
  selected: false
  version: string
}

export interface ProductReleasePlan {
  version: 1
  sequence: number
  intentIds: string[]
  summaries: LocalizedReleaseSummary[]
  releaseUnits: Record<ProductReleaseUnit, SelectedReleaseUnit | SkippedReleaseUnit>
}

interface DesktopReleaseNotesManifest {
  version: string
  tag: string
  source: {
    baselineKind: 'previous-release'
    baselineRepository: string
    releaseRepository: string
    baselineCommit: string
  }
  content: Record<'zh' | 'en', { intro: string; sections: Array<{ heading: string; items: string[] }> }>
}

type ReleasedUnitManifest = {
  state: 'released'
  version: string
  tag: string
  workflowRun: string
  releaseUrl?: string
  artifactDigests?: string[]
  imageDigest?: string
  deployment?: string
  testFlightBuild?: number
}
type BlockedUnitManifest = {
  state: 'blocked'
  version: string
  tag: string
  reason: string
  workflowRun?: string
  releaseUrl?: string
  testFlightBuild?: number
}
type SkippedUnitManifest = { state: 'skipped'; version: string; tag: string }
export interface FinalReleaseManifest {
  version: 1
  planSequence: number
  candidateCommit: string
  releaseUnits: Record<ProductReleaseUnit, ReleasedUnitManifest | BlockedUnitManifest | SkippedUnitManifest>
}

interface PackageManifest {
  directory: string
  name: string
  version: string
  dependencies: string[]
}

interface PriorReleaseRunExpectation {
  repository: string
  candidateCommit: string
  allowedWorkflows: readonly string[]
}

interface ReleaseArtifactExpectation {
  surface: ProductReleaseUnit
  candidateCommit: string
  planPath: string
  productVersion: string
  buildNumber?: number
}

interface ValidatedReleaseArtifactManifest extends ReleaseArtifactExpectation {
  version: 1
  artifactDigests: Record<string, string>
  testFlight?: { buildNumber: number; workflowRun: string }
}

const BUMPS: readonly ReleaseBump[] = ['none', 'patch', 'minor', 'major']
const BUMP_RANK: Record<ReleaseBump, number> = { none: 0, patch: 1, minor: 2, major: 3 }
const APP_DIRECTORIES: Record<ProductReleaseUnit, string> = {
  desktop: 'apps/desktop',
  mobile: 'apps/mobile',
  platform: 'apps/platform',
}
const TAG_PREFIX: Record<ProductReleaseUnit, string> = {
  desktop: 'gestalt-v',
  mobile: 'mobile-v',
  platform: 'platform-v',
}

/** Explicit inputs outside workspace package closures that can alter a product artifact or promotion. */
export const PRODUCT_RELEASE_EXPLICIT_INPUTS: Readonly<Record<ProductReleaseUnit, readonly string[]>> = {
  desktop: [
    '.github/workflows/desktop-release.yml',
    'apps/desktop/',
  ],
  mobile: [
    '.github/workflows/mobile-companion-acceptance.yml',
    '.github/workflows/mobile-release.yml',
    'apps/mobile/',
  ],
  platform: [
    '.github/workflows/platform-deploy.yml',
    '.github/workflows/platform-image.yml',
    'apps/platform/',
  ],
}

const RELEASE_CONTROL_PREFIXES = ['.release-intents/', 'product-releases/'] as const
const CROSS_SURFACE_INPUT_PREFIXES = [
  'packages/platform/remote-protocol/',
  'packages/wire/',
] as const
const SHARED_RELEASE_INPUTS = new Set([
  '.github/workflows/product-release-plan.yml',
  '.github/workflows/product-release.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/release/product.ts',
])

/** Parse one reviewed release-intent record. */
export function parseReleaseIntent(value: unknown, source: string): ReleaseIntent {
  const record = requireRecord(value, `${source}: intent`)
  if (record.version !== 1) throw new Error(`${source}: version must be 1`)
  const id = requireNonEmptyString(record.id, `${source}: id`)
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`${source}: id must use lowercase letters, digits, and hyphens`)
  const summaryRecord = requireRecord(record.summary, `${source}: summary`)
  const summary = {
    en: requireNonEmptyString(summaryRecord.en, `${source}: summary.en`),
    zh: requireNonEmptyString(summaryRecord.zh, `${source}: summary.zh`),
  }
  if (Object.keys(summaryRecord).some(key => key !== 'en' && key !== 'zh')) {
    throw new Error(`${source}: summary contains an unknown locale`)
  }
  const releasesRecord = requireRecord(record.releases, `${source}: releases`)
  const releases = Object.fromEntries(PRODUCT_RELEASE_UNITS.map((unit) => {
    const bump = releasesRecord[unit]
    if (typeof bump !== 'string' || !BUMPS.includes(bump as ReleaseBump)) {
      throw new Error(`${source}: releases.${unit} must be major, minor, patch, or none`)
    }
    return [unit, bump]
  })) as Record<ProductReleaseUnit, ReleaseBump>
  if (Object.keys(releasesRecord).some(key => !PRODUCT_RELEASE_UNITS.includes(key as ProductReleaseUnit))) {
    throw new Error(`${source}: releases contains an unknown release unit`)
  }
  if (!Array.isArray(record.compatibilityExceptions)) {
    throw new Error(`${source}: compatibilityExceptions must be an array`)
  }
  const seen = new Set<ProductReleaseUnit>()
  const compatibilityExceptions = record.compatibilityExceptions.map((item, index) => {
    const exception = requireRecord(item, `${source}: compatibilityExceptions[${index}]`)
    const releaseUnit = exception.releaseUnit
    if (typeof releaseUnit !== 'string' || !PRODUCT_RELEASE_UNITS.includes(releaseUnit as ProductReleaseUnit)) {
      throw new Error(`${source}: compatibilityExceptions[${index}].releaseUnit is invalid`)
    }
    const typedUnit = releaseUnit as ProductReleaseUnit
    if (seen.has(typedUnit)) throw new Error(`${source}: compatibilityExceptions repeats ${typedUnit}`)
    seen.add(typedUnit)
    return {
      releaseUnit: typedUnit,
      reason: requireNonEmptyString(exception.reason, `${source}: compatibilityExceptions[${index}].reason`),
    }
  })
  return { version: 1, id, summary, releases, compatibilityExceptions }
}

/** Return under-reported release units or throw with an actionable diagnostic. */
export function validateReleaseIntent(intent: ReleaseIntent, impact: ReadonlySet<ProductReleaseUnit>): ProductReleaseUnit[] {
  const excepted = new Set(intent.compatibilityExceptions.map(exception => exception.releaseUnit))
  const missing = PRODUCT_RELEASE_UNITS.filter(unit => impact.has(unit)
    && intent.releases[unit] === 'none'
    && !excepted.has(unit))
  if (missing.length > 0) {
    throw new Error(`release intent ${intent.id} under-reports possible impact: ${missing.join(', ')}`)
  }
  return missing
}

/** Validate added intents as one deterministic, unique, unconsumed change set. */
export async function validateReleaseIntentAdditions(
  root: string,
  addedIntentPaths: readonly string[],
  impact: ReadonlySet<ProductReleaseUnit>,
): Promise<ReleaseIntent[]> {
  const normalized = [...new Set(addedIntentPaths.map(normalizePath))].sort()
  if (normalized.length === 0) {
    throw new Error('product changes require at least one added .release-intents/*.json record')
  }
  for (const path of normalized) {
    if (!/^\.release-intents\/[a-z0-9][a-z0-9-]*\.json$/u.test(path) || path === '.release-intents/schema.json') {
      throw new Error(`invalid added release intent path ${path}`)
    }
  }
  const records = await loadIntentRecords(root)
  const ids = new Map<string, string[]>()
  for (const record of records) {
    const paths = ids.get(record.intent.id) ?? []
    paths.push(record.path)
    ids.set(record.intent.id, paths)
  }
  for (const [id, paths] of ids) {
    if (paths.length > 1) throw new Error(`duplicate product release intent id ${id}: ${paths.sort().join(', ')}`)
  }
  const state = parseProductReleaseState(await readJson(join(root, 'product-releases/state.json')))
  const added = normalized.map((path) => {
    const record = records.find(candidate => candidate.path === path)
    if (record === undefined) throw new Error(`added release intent is not readable: ${path}`)
    if (path !== `.release-intents/${record.intent.id}.json`) {
      throw new Error(`${path}: filename must match intent id ${record.intent.id}`)
    }
    if (state.consumedIntentIds.includes(record.intent.id)) {
      throw new Error(`release intent ${record.intent.id} is already consumed`)
    }
    return record.intent
  })
  const covered = new Set<ProductReleaseUnit>()
  for (const intent of added) {
    for (const unit of PRODUCT_RELEASE_UNITS) {
      if (intent.releases[unit] !== 'none') covered.add(unit)
    }
  }
  const universallyExcepted = new Set(PRODUCT_RELEASE_UNITS.filter(unit => added.every(intent =>
    intent.compatibilityExceptions.some(exception => exception.releaseUnit === unit))))
  const missing = PRODUCT_RELEASE_UNITS.filter(unit => impact.has(unit) && !covered.has(unit) && !universallyExcepted.has(unit))
  if (missing.length > 0) {
    throw new Error(`added release intents under-report possible impact: ${missing.join(', ')}`)
  }
  return added.sort((left, right) => left.id.localeCompare(right.id))
}

/** Compute the conservative product impact of repository-relative changed paths. */
export async function computeProductImpact(root: string, changedPaths: readonly string[]): Promise<Set<ProductReleaseUnit>> {
  const normalized = [...new Set(changedPaths.map(normalizePath).filter(path => path !== ''))]
  const relevant = normalized.filter(path => !isDocumentationOrTest(path)
    && !RELEASE_CONTROL_PREFIXES.some(prefix => path.startsWith(prefix)))
  if (relevant.length === 0) return new Set()

  const manifests = await discoverPackageManifests(root)
  const manifestByName = new Map(manifests.map(manifest => [manifest.name, manifest]))
  const closures = new Map<ProductReleaseUnit, Set<string>>()
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const app = manifests.find(manifest => manifest.directory === APP_DIRECTORIES[unit])
    closures.set(unit, app === undefined ? new Set() : dependencyClosure(app, manifestByName))
  }

  const impacted = new Set<ProductReleaseUnit>()
  for (const path of relevant) {
    let matched = false
    if (CROSS_SURFACE_INPUT_PREFIXES.some(prefix => path.startsWith(prefix))) {
      PRODUCT_RELEASE_UNITS.forEach(unit => impacted.add(unit))
      continue
    }
    if (SHARED_RELEASE_INPUTS.has(path)) {
      PRODUCT_RELEASE_UNITS.forEach(unit => impacted.add(unit))
      continue
    }
    for (const unit of PRODUCT_RELEASE_UNITS) {
      if (PRODUCT_RELEASE_EXPLICIT_INPUTS[unit].some(input => input.endsWith('/')
        ? path.startsWith(input)
        : path === input)) {
        impacted.add(unit)
        matched = true
      }
    }
    const owner = manifests
      .filter(manifest => path === manifest.directory || path.startsWith(`${manifest.directory}/`))
      .sort((left, right) => right.directory.length - left.directory.length)[0]
    if (owner !== undefined) {
      matched = true
      for (const unit of PRODUCT_RELEASE_UNITS) {
        if (closures.get(unit)?.has(owner.name) === true) impacted.add(unit)
      }
    }
    if (!matched) PRODUCT_RELEASE_UNITS.forEach(unit => impacted.add(unit))
  }
  return impacted
}

/** Aggregate all unconsumed intent into one independent-version Product Release Plan. */
export async function aggregateProductRelease(
  root: string,
  intents: readonly ReleaseIntent[],
  state: ProductReleaseState,
): Promise<ProductReleasePlan> {
  validateState(state)
  const versions = {} as Record<ProductReleaseUnit, string>
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const manifest = requireRecord(await readJson(join(root, APP_DIRECTORIES[unit], 'package.json')), `${unit} package.json`)
    versions[unit] = requireNonEmptyString(manifest.version, `${unit} package version`)
  }
  const mobileRelease = await readJson(join(root, 'apps/mobile/release.json'))
  const mobileBuildNumber = requirePositiveInteger(requireRecord(mobileRelease, 'apps/mobile/release.json').buildNumber, 'mobile buildNumber')
  return aggregateProductReleaseFromAuthorities(intents, state, versions, mobileBuildNumber)
}

function aggregateProductReleaseFromAuthorities(
  intents: readonly ReleaseIntent[],
  state: ProductReleaseState,
  versions: Readonly<Record<ProductReleaseUnit, string>>,
  mobileBuildNumber: number,
): ProductReleasePlan {
  validateState(state)
  const consumed = new Set(state.consumedIntentIds)
  const pending = intents.filter(intent => !consumed.has(intent.id)).sort((left, right) => left.id.localeCompare(right.id))
  if (pending.length === 0) throw new Error('no unconsumed product release intents')
  if (new Set(pending.map(intent => intent.id)).size !== pending.length) throw new Error('duplicate product release intent id')

  const releaseUnits = {} as ProductReleasePlan['releaseUnits']
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const previousVersion = requireNonEmptyString(versions[unit], `${unit} package version`)
    const bump = pending.map(intent => intent.releases[unit]).reduce(highestBump, 'none')
    if (bump === 'none') {
      releaseUnits[unit] = { selected: false, version: previousVersion }
      continue
    }
    const version = bumpVersion(previousVersion, bump)
    releaseUnits[unit] = {
      selected: true,
      previousVersion,
      version,
      tag: `${TAG_PREFIX[unit]}${version}`,
      bump,
      summaries: pending.filter(intent => intent.releases[unit] !== 'none').map(intent => intent.summary),
      ...(unit === 'mobile' ? { buildNumber: mobileBuildNumber + 1 } : {}),
    }
  }
  return {
    version: 1,
    sequence: state.nextSequence,
    intentIds: pending.map(intent => intent.id),
    summaries: pending.map(intent => intent.summary),
    releaseUnits,
  }
}

/** Atomically write one retry-stable plan, its selected version authorities, and consumed-intent state. */
export async function writeProductRelease(root: string, plan: ProductReleasePlan, priorState: ProductReleaseState): Promise<void> {
  validateState(priorState)
  if (plan.sequence !== priorState.nextSequence) throw new Error('product release plan sequence is stale')
  const planPath = join(root, 'product-releases', `${String(plan.sequence).padStart(4, '0')}.json`)
  const plannedText = stableJson(plan)
  await mkdir(dirname(planPath), { recursive: true })
  const existing = await readOptional(planPath)
  if (existing !== undefined && existing !== plannedText) throw new Error(`product release plan ${plan.sequence} already exists with different content`)

  for (const unit of PRODUCT_RELEASE_UNITS) {
    const release = plan.releaseUnits[unit]
    if (!release.selected) continue
    const manifestPath = join(root, APP_DIRECTORIES[unit], 'package.json')
    const manifest = requireRecord(await readJson(manifestPath), `${unit} package.json`)
    const current = requireNonEmptyString(manifest.version, `${unit} package version`)
    if (current !== release.previousVersion && current !== release.version) {
      throw new Error(`${unit} package version moved from planned ${release.previousVersion} to ${current}`)
    }
    await writeAtomic(manifestPath, stableJson({ ...manifest, version: release.version }))
    if (unit === 'mobile') {
      await writeAtomic(join(root, 'apps/mobile/release.json'), stableJson({ version: 1, buildNumber: release.buildNumber }))
    }
  }
  const desktop = plan.releaseUnits.desktop
  if (desktop.selected) {
    const baselineCommit = runGit(root, ['rev-parse', `${TAG_PREFIX.desktop}${desktop.previousVersion}^{commit}`]).trim()
    const releaseNotes = renderDesktopReleaseNotes(plan, baselineCommit)
    await writeAtomic(
      join(root, 'apps/desktop/release-notes', `${desktop.version}.json`),
      stableJson(releaseNotes),
    )
  }
  await writeAtomic(planPath, plannedText)
  const nextState: ProductReleaseState = {
    version: 1,
    nextSequence: priorState.nextSequence + 1,
    consumedIntentIds: [...new Set([...priorState.consumedIntentIds, ...plan.intentIds])].sort(),
  }
  await writeAtomic(join(root, 'product-releases/state.json'), stableJson(nextState))
}

/** Render the Desktop workflow's tracked bilingual manifest from one aggregated plan. */
export function renderDesktopReleaseNotes(plan: ProductReleasePlan, baselineCommit: string): DesktopReleaseNotesManifest {
  const desktop = plan.releaseUnits.desktop
  if (!desktop.selected) throw new Error('Desktop release notes require a selected Desktop release unit')
  if (!/^[0-9a-f]{40}$/u.test(baselineCommit)) throw new Error('Desktop release-note baseline must be a full commit id')
  return {
    version: desktop.version,
    tag: desktop.tag,
    source: {
      baselineKind: 'previous-release',
      baselineRepository: 'gestaltrun/deepseek-harness-gestalt',
      releaseRepository: 'gestaltrun/deepseek-harness-gestalt',
      baselineCommit,
    },
    content: {
      zh: {
        intro: `DeepSeek Gestalt ${desktop.version} 收录上一版本之后的 {{commitCount}} 个提交。`,
        sections: [{ heading: '产品变更', items: desktop.summaries.map(summary => summary.zh) }],
      },
      en: {
        intro: `DeepSeek Gestalt ${desktop.version} contains the {{commitCount}} commits after the previous Desktop Bundle.`,
        sections: [{ heading: 'Product changes', items: desktop.summaries.map(summary => summary.en) }],
      },
    },
  }
}

/** Validate the narrow generated-version PR that consumes intents instead of introducing another one. */
export async function validateProductReleasePlanChange(root: string, changedPaths: readonly string[], baseRef?: string): Promise<number> {
  const planPaths = changedPaths.filter(path => /^product-releases\/\d{4}\.json$/u.test(normalizePath(path)))
  if (planPaths.length !== 1) throw new Error(`generated Product Release PR requires exactly one numbered plan; found ${planPaths.length}`)
  const planPath = normalizePath(planPaths[0] as string)
  const typedPlan = parseProductReleasePlan(await readJson(join(root, planPath)), planPath)
  const plan = typedPlan as unknown as Record<string, unknown>
  const sequence = typedPlan.sequence
  if (planPath !== `product-releases/${String(sequence).padStart(4, '0')}.json`) throw new Error(`${planPath}: sequence does not match filename`)
  if (!Array.isArray(plan.intentIds) || plan.intentIds.length === 0 || plan.intentIds.some(id => typeof id !== 'string' || id === '')) {
    throw new Error(`${planPath}: intentIds must contain at least one id`)
  }
  const releaseUnits = requireRecord(plan.releaseUnits, `${planPath}: releaseUnits`)
  const allowed = new Set([planPath, 'product-releases/state.json'])
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const release = requireRecord(releaseUnits[unit], `${planPath}: releaseUnits.${unit}`)
    if (release.selected !== true && release.selected !== false) throw new Error(`${planPath}: ${unit}.selected must be boolean`)
    const packagePath = `${APP_DIRECTORIES[unit]}/package.json`
    if (release.selected) {
      allowed.add(packagePath)
      const manifest = requireRecord(await readJson(join(root, packagePath)), packagePath)
      if (manifest.version !== release.version) throw new Error(`${packagePath}: version does not match ${planPath}`)
      if (unit === 'mobile') {
        allowed.add('apps/mobile/release.json')
        const mobileRelease = requireRecord(await readJson(join(root, 'apps/mobile/release.json')), 'apps/mobile/release.json')
        if (mobileRelease.buildNumber !== release.buildNumber) throw new Error(`apps/mobile/release.json: buildNumber does not match ${planPath}`)
      }
      if (unit === 'desktop') allowed.add(`apps/desktop/release-notes/${String(release.version)}.json`)
    }
  }
  for (const path of changedPaths.map(normalizePath)) {
    if (!allowed.has(path)) throw new Error(`generated Product Release PR contains unexpected path ${path}`)
  }
  const state = requireRecord(await readJson(join(root, 'product-releases/state.json')), 'product-releases/state.json')
  const typedHeadState = parseProductReleaseState(state)
  if (state.nextSequence !== sequence + 1) throw new Error('product-releases/state.json: nextSequence does not follow plan')
  const planIntentIds = plan.intentIds as unknown[]
  const consumedIntentIds = state.consumedIntentIds
  if (!Array.isArray(consumedIntentIds) || !planIntentIds.every(id => consumedIntentIds.includes(id))) {
    throw new Error('product-releases/state.json: plan intents are not consumed')
  }
  if (baseRef !== undefined) {
    const baseCommit = runGit(root, ['merge-base', baseRef, 'HEAD']).trim()
    const baseState = parseProductReleaseState(gitJsonAt(root, baseCommit, 'product-releases/state.json'))
    const versions = {} as Record<ProductReleaseUnit, string>
    for (const unit of PRODUCT_RELEASE_UNITS) {
      const manifest = requireRecord(gitJsonAt(root, baseCommit, `${APP_DIRECTORIES[unit]}/package.json`), `${unit} base package.json`)
      versions[unit] = requireNonEmptyString(manifest.version, `${unit} base package version`)
    }
    const baseMobile = requireRecord(gitJsonAt(root, baseCommit, 'apps/mobile/release.json'), 'base apps/mobile/release.json')
    const baseBuild = requirePositiveInteger(baseMobile.buildNumber, 'base Mobile build number')
    const expected = aggregateProductReleaseFromAuthorities(await loadIntents(root), baseState, versions, baseBuild)
    if (stableJson(typedPlan) !== stableJson(expected)) {
      throw new Error(`${planPath}: content does not match the base ledger and unconsumed intents`)
    }
    const expectedState: ProductReleaseState = {
      version: 1,
      nextSequence: baseState.nextSequence + 1,
      consumedIntentIds: [...new Set([...baseState.consumedIntentIds, ...expected.intentIds])].sort(),
    }
    if (stableJson(typedHeadState) !== stableJson(expectedState)) {
      throw new Error('product-releases/state.json does not match the recomputed release transaction')
    }
    for (const unit of PRODUCT_RELEASE_UNITS) {
      const packagePath = `${APP_DIRECTORIES[unit]}/package.json`
      const baseManifest = requireRecord(gitJsonAt(root, baseCommit, packagePath), `${unit} base package.json`)
      const release = expected.releaseUnits[unit]
      const expectedManifest = release.selected ? { ...baseManifest, version: release.version } : baseManifest
      const headManifest = requireRecord(await readJson(join(root, packagePath)), `${unit} package.json`)
      if (stableJson(headManifest) !== stableJson(expectedManifest)) {
        throw new Error(`${packagePath}: generated transaction may change only the version field`)
      }
    }
    const baseMobileRelease = requireRecord(gitJsonAt(root, baseCommit, 'apps/mobile/release.json'), 'base apps/mobile/release.json')
    const mobile = expected.releaseUnits.mobile
    const expectedMobileRelease = mobile.selected
      ? { ...baseMobileRelease, buildNumber: mobile.buildNumber }
      : baseMobileRelease
    const headMobileRelease = requireRecord(await readJson(join(root, 'apps/mobile/release.json')), 'apps/mobile/release.json')
    if (stableJson(headMobileRelease) !== stableJson(expectedMobileRelease)) {
      throw new Error('apps/mobile/release.json: generated transaction may change only buildNumber')
    }
    const desktop = expected.releaseUnits.desktop
    if (desktop.selected) {
      const baselineCommit = runGit(root, ['rev-parse', `${TAG_PREFIX.desktop}${desktop.previousVersion}^{commit}`]).trim()
      const notesPath = `apps/desktop/release-notes/${desktop.version}.json`
      if (stableJson(await readJson(join(root, notesPath))) !== stableJson(renderDesktopReleaseNotes(expected, baselineCommit))) {
        throw new Error(`${notesPath}: content does not match the recomputed Desktop summaries`)
      }
    }
  }
  return sequence
}

/** Bind one numbered plan to an exact checkout and its source-owned version authorities. */
export async function validateProductReleaseCandidate(
  root: string,
  planPath: string,
  candidateCommit: string,
  checkoutCommit: string,
  masterRef?: string,
): Promise<ProductReleasePlan> {
  const normalizedPath = normalizePath(planPath)
  if (!/^product-releases\/\d{4}\.json$/u.test(normalizedPath)) {
    throw new Error(`invalid Product Release Plan path ${normalizedPath}`)
  }
  const candidate = requireFullCommit(candidateCommit, 'candidate commit')
  const checkout = requireFullCommit(checkoutCommit, 'candidate checkout')
  if (checkout !== candidate) throw new Error(`candidate checkout ${checkout} does not match ${candidate}`)
  const plan = parseProductReleasePlan(await readJson(join(root, normalizedPath)), normalizedPath)
  if (normalizedPath !== `product-releases/${String(plan.sequence).padStart(4, '0')}.json`) {
    throw new Error(`${normalizedPath}: sequence does not match filename`)
  }
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const release = plan.releaseUnits[unit]
    const packagePath = join(root, APP_DIRECTORIES[unit], 'package.json')
    const manifest = requireRecord(await readJson(packagePath), `${unit} package.json`)
    if (manifest.version !== release.version) {
      throw new Error(`${unit} package version does not match ${normalizedPath}`)
    }
    if (unit === 'mobile' && release.selected) {
      const mobile = requireRecord(await readJson(join(root, 'apps/mobile/release.json')), 'apps/mobile/release.json')
      if (mobile.buildNumber !== release.buildNumber) {
        throw new Error(`Mobile build number does not match ${normalizedPath}`)
      }
    }
  }
  if (masterRef !== undefined) {
    const ancestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', candidate, masterRef])
    if (ancestor.status !== 0) throw new Error(`candidate ${candidate} is not reachable from master`)
    const masterState = parseProductReleaseState(gitJsonAt(root, masterRef, 'product-releases/state.json'))
    if (plan.sequence !== masterState.nextSequence - 1) {
      throw new Error(`${normalizedPath} is not the latest Product Release Plan in the master ledger`)
    }
    const masterIntents = loadIntentRecordsAtRef(root, masterRef)
    const consumed = new Set(masterState.consumedIntentIds)
    const pending = masterIntents.filter(record => !consumed.has(record.intent.id)).map(record => record.intent.id).sort()
    if (pending.length > 0) {
      throw new Error(`master has unconsumed product release intent: ${pending.join(', ')}`)
    }
  }
  return plan
}

/** Validate GitHub Actions provenance for a prior artifact or deployment run. */
export function validatePriorReleaseRun(value: unknown, expected: PriorReleaseRunExpectation): { workflowRun: string; workflow: string } {
  const run = requireRecord(value, 'prior release run')
  const repository = requireRecord(run.repository, 'prior release run repository')
  if (repository.full_name !== expected.repository) throw new Error('prior release run belongs to a different repository')
  if (run.conclusion !== 'success') throw new Error('prior release run must be successful')
  if (run.head_sha !== requireFullCommit(expected.candidateCommit, 'candidate commit')) {
    throw new Error('prior release run head SHA does not match candidate')
  }
  const workflow = requireNonEmptyString(run.path, 'prior release run workflow')
  if (!expected.allowedWorkflows.includes(workflow)) throw new Error(`prior release run workflow is not allowed: ${workflow}`)
  const workflowRun = requireActionsRunUrl(run.html_url, 'prior release run URL')
  return { workflowRun, workflow }
}

/** Validate one signed-candidate manifest and the digests recomputed after download. */
export function validateReleaseArtifactManifest(
  value: unknown,
  expected: ReleaseArtifactExpectation,
  actualDigests: Readonly<Record<string, string>>,
): ValidatedReleaseArtifactManifest {
  const manifest = requireRecord(value, 'release artifact manifest')
  if (manifest.version !== 1) throw new Error('release artifact manifest version must be 1')
  if (manifest.surface !== expected.surface) throw new Error('release artifact manifest surface does not match')
  if (manifest.candidateCommit !== requireFullCommit(expected.candidateCommit, 'candidate commit')) {
    throw new Error('release artifact manifest candidate does not match')
  }
  if (manifest.planPath !== expected.planPath) throw new Error('release artifact manifest plan does not match')
  if (manifest.productVersion !== expected.productVersion) throw new Error('release artifact manifest product version does not match')
  if (expected.buildNumber !== undefined && manifest.buildNumber !== expected.buildNumber) {
    throw new Error('release artifact manifest build number does not match')
  }
  const artifactDigestsRecord = requireRecord(manifest.artifactDigests, 'release artifact manifest digests')
  const artifactDigests: Record<string, string> = {}
  for (const [name, digest] of Object.entries(artifactDigestsRecord).sort(([left], [right]) => left.localeCompare(right))) {
    if (name === '' || typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error('release artifact manifest contains an invalid digest')
    }
    artifactDigests[name] = digest
  }
  const normalizedActual = Object.fromEntries(Object.entries(actualDigests).sort(([left], [right]) => left.localeCompare(right)))
  if (stableJson(artifactDigests) !== stableJson(normalizedActual)) {
    throw new Error('release artifact manifest digests do not match downloaded artifacts')
  }
  let testFlight: ValidatedReleaseArtifactManifest['testFlight']
  if (manifest.testFlight !== undefined) {
    const evidence = requireRecord(manifest.testFlight, 'release artifact manifest TestFlight evidence')
    const buildNumber = requirePositiveInteger(evidence.buildNumber, 'TestFlight build number')
    if (expected.buildNumber !== undefined && buildNumber !== expected.buildNumber) {
      throw new Error('TestFlight build does not match release artifact build')
    }
    testFlight = { buildNumber, workflowRun: requireActionsRunUrl(evidence.workflowRun, 'TestFlight workflow run') }
  }
  return {
    version: 1,
    ...expected,
    artifactDigests,
    ...(testFlight === undefined ? {} : { testFlight }),
  }
}

/** Reject a movable or candidate-mismatched Platform promotion identity. */
export function assertImmutablePlatformCandidate(identity: string, candidateCommit: string, imageCandidateCommit: string): string {
  const candidate = requireFullCommit(candidateCommit, 'candidate commit')
  const imageCandidate = requireFullCommit(imageCandidateCommit, 'image candidate commit')
  if (imageCandidate !== candidate) throw new Error(`Platform image candidate ${imageCandidate} does not match ${candidate}`)
  if (!/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/u.test(identity)) {
    throw new Error('Platform promotion requires a full OCI digest bound to the image candidate; tags and short digests are forbidden')
  }
  return identity
}

/** Validate and return the final, machine-readable release evidence manifest. */
export function renderReleaseManifest(input: Omit<FinalReleaseManifest, 'version'>): FinalReleaseManifest {
  if (!Number.isSafeInteger(input.planSequence) || input.planSequence < 1) throw new Error('planSequence must be positive')
  requireNonEmptyString(input.candidateCommit, 'candidateCommit')
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const result = input.releaseUnits[unit]
    requireNonEmptyString(result.version, `${unit} version`)
    requireNonEmptyString(result.tag, `${unit} tag`)
    if (result.state === 'released') {
      requireActionsRunUrl(result.workflowRun, `${unit} workflowRun`)
      if (result.releaseUrl !== undefined) requireReleaseUrl(result.releaseUrl, `${unit} releaseUrl`)
      if (unit === 'platform' && result.imageDigest === undefined) {
        throw new Error('released Platform manifest requires imageDigest')
      }
    } else if (result.state === 'blocked') {
      requireNonEmptyString(result.reason, `${unit} blocked reason`)
      if (result.workflowRun !== undefined) requireActionsRunUrl(result.workflowRun, `${unit} workflowRun`)
      if (result.releaseUrl !== undefined) requireReleaseUrl(result.releaseUrl, `${unit} releaseUrl`)
    }
    if ('testFlightBuild' in result) {
      requirePositiveInteger(result.testFlightBuild, `${unit} testFlightBuild`)
    }
  }
  return { version: 1, ...input }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function requireFullCommit(value: unknown, label: string): string {
  const commit = requireNonEmptyString(value, label)
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`${label} must be a full commit id`)
  return commit
}

function requireActionsRunUrl(value: unknown, label: string): string {
  const url = requireNonEmptyString(value, label)
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/u.test(url)) {
    throw new Error(`${label} must be a GitHub Actions run URL`)
  }
  return url
}

function requireReleaseUrl(value: unknown, label: string): string {
  const url = requireNonEmptyString(value, label)
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/[^/]+$/u.test(url)) {
    throw new Error(`${label} must be a GitHub Release URL`)
  }
  return url
}

function validateState(state: ProductReleaseState): void {
  requirePositiveInteger(state.nextSequence, 'nextSequence')
  if (!Array.isArray(state.consumedIntentIds) || state.consumedIntentIds.some(id => typeof id !== 'string' || id === '')) {
    throw new Error('consumedIntentIds must contain non-empty strings')
  }
}

function parseProductReleaseState(value: unknown): ProductReleaseState {
  const state = requireRecord(value, 'product-releases/state.json')
  if (state.version !== 1) throw new Error('product release state version must be 1')
  const typed: ProductReleaseState = {
    version: 1,
    nextSequence: state.nextSequence as number,
    consumedIntentIds: state.consumedIntentIds as string[],
  }
  validateState(typed)
  return typed
}

function parseProductReleasePlan(value: unknown, source: string): ProductReleasePlan {
  const record = requireRecord(value, source)
  if (record.version !== 1) throw new Error(`${source}: version must be 1`)
  const sequence = requirePositiveInteger(record.sequence, `${source}: sequence`)
  if (!Array.isArray(record.intentIds) || record.intentIds.some(id => typeof id !== 'string' || id === '')) {
    throw new Error(`${source}: intentIds must contain non-empty strings`)
  }
  const summaries = parseLocalizedSummaries(record.summaries, `${source}: summaries`)
  const units = requireRecord(record.releaseUnits, `${source}: releaseUnits`)
  const releaseUnits = {} as ProductReleasePlan['releaseUnits']
  for (const unit of PRODUCT_RELEASE_UNITS) {
    const release = requireRecord(units[unit], `${source}: releaseUnits.${unit}`)
    const version = requireNonEmptyString(release.version, `${source}: releaseUnits.${unit}.version`)
    if (release.selected === false) {
      releaseUnits[unit] = { selected: false, version }
      continue
    }
    if (release.selected !== true) throw new Error(`${source}: releaseUnits.${unit}.selected must be boolean`)
    const unitSummaries = parseLocalizedSummaries(release.summaries, `${source}: releaseUnits.${unit}.summaries`)
    if (unitSummaries.length === 0) throw new Error(`${source}: releaseUnits.${unit}.summaries must not be empty`)
    releaseUnits[unit] = {
      selected: true,
      previousVersion: requireNonEmptyString(release.previousVersion, `${source}: releaseUnits.${unit}.previousVersion`),
      version,
      tag: requireNonEmptyString(release.tag, `${source}: releaseUnits.${unit}.tag`),
      bump: requireReleaseBump(release.bump, `${source}: releaseUnits.${unit}.bump`),
      summaries: unitSummaries,
      ...(unit === 'mobile' ? { buildNumber: requirePositiveInteger(release.buildNumber, `${source}: Mobile build number`) } : {}),
    }
  }
  return {
    version: 1,
    sequence,
    intentIds: record.intentIds as string[],
    summaries,
    releaseUnits,
  }
}

function requireReleaseBump(value: unknown, label: string): Exclude<ReleaseBump, 'none'> {
  if (value !== 'patch' && value !== 'minor' && value !== 'major') throw new Error(`${label} must be patch, minor, or major`)
  return value
}

function parseLocalizedSummaries(value: unknown, label: string): LocalizedReleaseSummary[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => {
    const record = requireRecord(item, `${label}[${index}]`)
    return {
      en: requireNonEmptyString(record.en, `${label}[${index}].en`),
      zh: requireNonEmptyString(record.zh, `${label}[${index}].zh`),
    }
  })
}

function normalizePath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//u, '')
}

function isDocumentationOrTest(path: string): boolean {
  return path.startsWith('docs/')
    || path.startsWith('.agents/')
    || path === 'README.md'
    || path === 'README.zh.md'
    || path.includes('/tests/')
    || /(?:^|\/)test(?:s)?\//u.test(path)
    || /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path)
    || path.endsWith('.md')
}

async function discoverPackageManifests(root: string): Promise<PackageManifest[]> {
  const paths: string[] = []
  await collectWorkspacePackageJson(join(root, 'apps'), 1, paths)
  await collectWorkspacePackageJson(join(root, 'packages'), 2, paths)
  const manifests: PackageManifest[] = []
  for (const path of paths) {
    const parsed = requireRecord(await readJson(path), relative(root, path))
    const name = requireNonEmptyString(parsed.name, `${relative(root, path)} name`)
    const version = requireNonEmptyString(parsed.version, `${relative(root, path)} version`)
    const dependencies = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const value = parsed[field]
      if (value === undefined) continue
      Object.keys(requireRecord(value, `${relative(root, path)} ${field}`)).forEach(dependency => dependencies.add(dependency))
    }
    manifests.push({ directory: normalizePath(relative(root, dirname(path))), name, version, dependencies: [...dependencies] })
  }
  return manifests
}

async function collectWorkspacePackageJson(directory: string, remainingDepth: number, paths: string[]): Promise<void> {
  try {
    if (remainingDepth === 0) {
      const manifest = join(directory, 'package.json')
      if (await readOptional(manifest) !== undefined) paths.push(manifest)
      return
    }
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) await collectWorkspacePackageJson(join(directory, entry.name), remainingDepth - 1, paths)
    }
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
}

function dependencyClosure(root: PackageManifest, byName: ReadonlyMap<string, PackageManifest>): Set<string> {
  const reached = new Set<string>()
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || reached.has(current.name)) continue
    reached.add(current.name)
    for (const dependency of current.dependencies) {
      const manifest = byName.get(dependency)
      if (manifest !== undefined) pending.push(manifest)
    }
  }
  return reached
}

function highestBump(left: ReleaseBump, right: ReleaseBump): ReleaseBump {
  return BUMP_RANK[right] > BUMP_RANK[left] ? right : left
}

function bumpVersion(version: string, bump: Exclude<ReleaseBump, 'none'>): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.exec(version)
  if (match === null) throw new Error(`cannot bump non-SemVer product version ${version}`)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (version.includes('-')) return `${major}.${minor}.${patch}`
  return `${major}.${minor}.${patch + 1}`
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function loadIntents(root: string): Promise<ReleaseIntent[]> {
  return (await loadIntentRecords(root)).map(record => record.intent)
}

async function loadIntentRecords(root: string): Promise<Array<{ path: string; intent: ReleaseIntent }>> {
  const directory = join(root, '.release-intents')
  const entries = await readdir(directory)
  const intents: Array<{ path: string; intent: ReleaseIntent }> = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json') || entry === 'schema.json') continue
    const path = `.release-intents/${entry}`
    intents.push({ path, intent: parseReleaseIntent(await readJson(join(directory, entry)), path) })
  }
  return intents
}

function loadIntentRecordsAtRef(root: string, ref: string): Array<{ path: string; intent: ReleaseIntent }> {
  const names = runGit(root, ['ls-tree', '-r', '--name-only', ref, '--', '.release-intents']).trim().split('\n').filter(Boolean)
  const records: Array<{ path: string; intent: ReleaseIntent }> = []
  for (const path of names.sort()) {
    if (!path.endsWith('.json') || path.endsWith('/schema.json')) continue
    records.push({ path, intent: parseReleaseIntent(gitJsonAt(root, ref, path), path) })
  }
  return records
}

function gitPaths(root: string, base: string, head: string): string[] {
  const mergeBase = runGit(root, ['merge-base', base, head]).trim()
  const result = spawnSync('git', ['-C', root, 'diff', '--name-only', '-z', mergeBase, head], { encoding: 'buffer' })
  if (result.status !== 0) throw new Error(`cannot read product release diff: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout.toString('utf8').split('\0').filter(Boolean)
}

function gitAddedPaths(root: string, base: string, head: string): string[] {
  const mergeBase = runGit(root, ['merge-base', base, head]).trim()
  const result = spawnSync('git', ['-C', root, 'diff', '--diff-filter=A', '--name-only', '-z', mergeBase, head], { encoding: 'buffer' })
  if (result.status !== 0) throw new Error(`cannot read added product release paths: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout.toString('utf8').split('\0').filter(Boolean)
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr.trim()}`)
  return result.stdout
}

function gitJsonAt(root: string, ref: string, path: string): unknown {
  const source = runGit(root, ['show', `${ref}:${path}`])
  return JSON.parse(source) as unknown
}

async function main(args: string[]): Promise<void> {
  const command = args[0]
  const root = resolve(import.meta.dirname, '../..')
  if (command === 'validate') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { base: { type: 'string' }, head: { type: 'string', default: 'HEAD' } },
      strict: true,
    })
    if (values.base === undefined) throw new Error('product release validate requires --base <ref>')
    const changedPaths = gitPaths(root, values.base, values.head)
    const addedPaths = gitAddedPaths(root, values.base, values.head)
    const intentPaths = changedPaths.filter(path => path.startsWith('.release-intents/')
      && path.endsWith('.json') && !path.endsWith('/schema.json'))
    if (intentPaths.length === 0 && changedPaths.some(path => /^product-releases\/\d{4}\.json$/u.test(path))) {
      const sequence = await validateProductReleasePlanChange(root, changedPaths, values.base)
      process.stdout.write(stableJson({ productReleasePlan: sequence, changedPaths }))
      return
    }
    const impact = await computeProductImpact(root, changedPaths)
    if (impact.size === 0 && intentPaths.length === 0) {
      process.stdout.write(stableJson({ intents: [], changedPaths, possibleImpact: [] }))
      return
    }
    const addedIntentPaths = addedPaths.filter(path => path.startsWith('.release-intents/')
      && path.endsWith('.json') && !path.endsWith('/schema.json'))
    if (intentPaths.length !== addedIntentPaths.length) {
      throw new Error('release intent records must be added; modifying or deleting an existing intent is forbidden')
    }
    const intents = await validateReleaseIntentAdditions(root, addedIntentPaths, impact)
    process.stdout.write(stableJson({ intents: intents.map(intent => intent.id), changedPaths, possibleImpact: [...impact].sort() }))
    return
  }
  if (command === 'prepare') {
    const { values } = parseArgs({ args: args.slice(1), options: { write: { type: 'boolean', default: false } }, strict: true })
    const typedState = parseProductReleaseState(await readJson(join(root, 'product-releases/state.json')))
    const intents = await loadIntents(root)
    const pending = intents.filter(intent => !new Set(typedState.consumedIntentIds).has(intent.id))
    if (pending.length === 0) {
      process.stdout.write(stableJson({ pending: false }))
      return
    }
    const plan = await aggregateProductRelease(root, pending, typedState)
    if (values.write) await writeProductRelease(root, plan, typedState)
    process.stdout.write(stableJson({ pending: true, plan }))
    return
  }
  if (command === 'candidate') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        plan: { type: 'string' },
        candidate: { type: 'string' },
        master: { type: 'string' },
      },
      strict: true,
    })
    if (values.plan === undefined || values.candidate === undefined || values.master === undefined) {
      throw new Error('product release candidate requires --plan, --candidate, and --master')
    }
    const checkout = runGit(root, ['rev-parse', 'HEAD']).trim()
    const plan = await validateProductReleaseCandidate(root, values.plan, values.candidate, checkout, values.master)
    process.stdout.write(stableJson({ plan }))
    return
  }
  throw new Error('usage: product.ts validate --base <ref> [--head <ref>] | prepare [--write] | candidate --plan <path> --candidate <sha> --master <ref>')
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`product-release: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
