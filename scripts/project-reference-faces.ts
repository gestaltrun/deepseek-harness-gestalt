/** Validate compiler-face isolation across workspace Project Reference graphs. */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export type ProjectFace = 'host' | 'client'

export const GESTALT_COMPILER_FACES: Readonly<Record<ProjectFace, readonly string[]>> = {
  host: [
    'apps/desktop',
    'apps/platform',
    'packages/browser/browser-runtime',
    'packages/browser/browser-runtime-deterministic',
    'packages/browser/browser-runtime-electron',
    'packages/browser/browser-runtime-tandem',
    'packages/browser/browser-workspace',
    'packages/browser/tool-browser',
    'packages/core/agent-tool-eligibility',
    'packages/core/tools-eligibility',
    'packages/host/apiproxy',
    'packages/interaction/member-question-receiver',
    'packages/interaction/member-question-sender',
    'packages/interaction/tool-project-members',
    'packages/platform/noise-channel',
    'packages/platform/platform-account',
    'packages/platform/platform-account-core',
    'packages/platform/platform-account-http',
    'packages/platform/project-membership',
    'packages/platform/project-membership-core',
    'packages/platform/project-membership-desktop',
    'packages/platform/project-membership-http',
    'packages/platform/remote-access',
    'packages/platform/remote-access-http',
    'packages/platform/remote-access-redis',
    'packages/platform/remote-attachments',
    'packages/platform/remote-protocol',
  ],
  client: [
    'apps/mobile',
    'packages/client/runtime',
    'packages/client/ui-better-sidebar',
    'packages/client/ui-browser',
    'packages/client/ui-desktop',
    'packages/client/ui-member-questions',
    'packages/client/ui-workbench',
    'packages/platform/platform-account-client',
    'packages/platform/project-membership-client',
    'packages/platform/remote-access-client',
  ],
}

interface ProjectReferenceConfig {
  readonly extends?: unknown
  readonly include?: readonly unknown[]
  readonly exclude?: readonly unknown[]
  readonly references?: ReadonlyArray<{ readonly path?: unknown }>
}

const WORKSPACE_MANIFESTS = [
  'packages/*/*/package.json',
  'apps/*/package.json',
  'vendor/*/package.json',
] as const

const GESTALT_PROJECT_PATTERNS = [
  'apps/{desktop,mobile,platform}/tsconfig.json',
  'packages/browser/*/tsconfig.json',
  'packages/client/{runtime,ui-better-sidebar,ui-browser,ui-desktop,ui-member-questions,ui-workbench}/tsconfig.json',
  'packages/core/{agent-tool-eligibility,tools-eligibility}/tsconfig.json',
  'packages/host/apiproxy/tsconfig.json',
  'packages/interaction/{member-question-receiver,member-question-sender,tool-project-members}/tsconfig.json',
  'packages/platform/*/tsconfig.json',
] as const

/**
 * Find references that enter the wrong leaf of a split Host/Client project.
 *
 * A single-config project is neutral and may participate in either graph. Once
 * a package declares both face configs, every reachable reference must name
 * the leaf matching the aggregate from which traversal began.
 *
 * @param root - Repository root containing both aggregate tsconfigs.
 * @returns Repo-relative diagnostics for every mismatched reference edge.
 */
export function collectProjectReferenceFaceViolations(root: string): string[] {
  const splitRoots = splitProjectRoots(root)
  const violations = [
    ...collectGestaltCompilerFaceViolations(root),
    ...collectWebHostTestFaceViolations(root),
  ]
  const pending = [resolve(root, 'tsconfig.host.json'), resolve(root, 'tsconfig.client.json')]
  const visited = new Set<string>()
  for (let configPath = pending.pop(); configPath !== undefined; configPath = pending.pop()) {
    if (visited.has(configPath) || !existsSync(configPath)) continue
    visited.add(configPath)
    const config = projectConfig(root, configPath)
    const face = projectFace(root, configPath, config)
    for (const reference of projectReferences(config)) {
      const targetConfig = referenceConfigPath(configPath, reference)
      const splitRoot = containingSplitRoot(splitRoots, targetConfig)
      if (splitRoot !== undefined) {
        if (face === undefined) {
          violations.push(
            `${repoPath(root, configPath)}: Project Reference ${JSON.stringify(reference)} enters split project ${repoPath(root, splitRoot)} from a config with no Host/Client face`,
          )
          continue
        }
        const expected = resolve(splitRoot, `tsconfig.${face}.json`)
        if (targetConfig !== expected) {
          violations.push(
            `${repoPath(root, configPath)}: Project Reference ${JSON.stringify(reference)} enters split project ${repoPath(root, splitRoot)} from a ${faceLabel(face)} config; reference ${JSON.stringify(repoPath(root, expected))} instead`,
          )
          continue
        }
      }
      pending.push(targetConfig)
    }
  }

  return violations.sort()
}

/**
 * Find retained Gestalt projects omitted from their required root aggregate.
 *
 * @param root - Repository root containing the compiler aggregates.
 * @returns Repo-relative diagnostics for every missing Gestalt compiler face.
 */
export function collectGestaltCompilerFaceViolations(
  root: string,
  inventory: Readonly<Record<ProjectFace, readonly string[]>> = GESTALT_COMPILER_FACES,
): string[] {
  const violations: string[] = []
  const discovered = discoverGestaltCompilerFaces(root)
  for (const face of ['host', 'client'] as const) {
    const aggregate = resolve(root, `tsconfig.${face}.json`)
    const references = new Set(projectReferences(projectConfig(root, aggregate))
      .map(reference => referenceConfigPath(aggregate, reference)))
    const declared = new Set(inventory[face])
    for (const directory of discovered[face]) {
      if (!declared.has(directory)) {
        violations.push(`${directory}/tsconfig.json: retained Gestalt ${faceLabel(face)} project is omitted from GESTALT_COMPILER_FACES`)
      }
    }
    for (const directory of declared) {
      const expected = resolve(root, directory, 'tsconfig.json')
      if (!existsSync(expected)) continue
      if (!discovered[face].has(directory)) {
        violations.push(`${directory}/tsconfig.json: GESTALT_COMPILER_FACES classifies a project not discovered as ${faceLabel(face)}`)
      }
      if (!references.has(expected)) {
        violations.push(`${directory}/tsconfig.json: retained Gestalt project is omitted from the root ${faceLabel(face)} aggregate`)
      }
    }
  }
  return violations.sort()
}

/**
 * Find Web tests whose direct scaffold dependency is missing from either compiler face.
 *
 * @param root - Repository root containing the Web tests and aggregate tsconfigs.
 * @returns Repo-relative diagnostics for missing or stale exact Web test entries.
 */
export function collectWebHostTestFaceViolations(root: string): string[] {
  const webConfigPath = resolve(root, 'apps/web/tsconfig.json')
  const hostConfigPath = resolve(root, 'tsconfig.host.json')
  if (!existsSync(webConfigPath) || !existsSync(hostConfigPath)) return []

  const webConfig = projectConfig(root, webConfigPath)
  const hostConfig = projectConfig(root, hostConfigPath)
  const webExcludes = stringEntries(webConfig.exclude)
  const hostIncludes = stringEntries(hostConfig.include)
  const scaffoldConsumers = discoverDirectScaffoldConsumers(root)
  const violations: string[] = []

  if (scaffoldConsumers.size === 0) {
    violations.push('apps/web/tests: no static direct ./scaffold.ts imports discovered; Web Host-test compiler-face validation requires a non-empty corpus')
  }

  for (const consumer of scaffoldConsumers) {
    const webEntry = consumer.slice('apps/web/'.length)
    if (!webExcludes.has(webEntry)) {
      violations.push(`apps/web/tsconfig.json: ${consumer} statically imports "./scaffold.ts" and must be listed exactly as ${JSON.stringify(webEntry)} in exclude`)
    }
    if (!hostIncludes.has(consumer)) {
      violations.push(`tsconfig.host.json: ${consumer} statically imports "./scaffold.ts" and must be listed exactly in include`)
    }
  }

  collectStaleWebTestEntries(root, 'apps/web/tsconfig.json', webExcludes, 'tests/', violations)
  collectStaleWebTestEntries(root, 'tsconfig.host.json', hostIncludes, 'apps/web/tests/', violations)
  return violations.sort()
}

function discoverDirectScaffoldConsumers(root: string): Set<string> {
  const consumers = new Set<string>()
  for (const relativePath of globSync('apps/web/tests/*.{ts,tsx}', { cwd: root })) {
    const normalizedPath = normalizePath(relativePath)
    const sourceText = readFileSync(resolve(root, relativePath), 'utf8')
    const scriptKind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(normalizedPath, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
    if (sourceFile.statements.some(statement => isStaticScaffoldImport(statement))) {
      consumers.add(normalizedPath)
    }
  }
  return consumers
}

function isStaticScaffoldImport(statement: ts.Statement): boolean {
  return ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === './scaffold.ts'
}

function collectStaleWebTestEntries(
  root: string,
  configPath: string,
  entries: ReadonlySet<string>,
  prefix: string,
  violations: string[],
): void {
  for (const entry of entries) {
    if (!isExactWebTestFileEntry(entry, prefix)) continue
    const repoRelative = configPath === 'apps/web/tsconfig.json' ? `apps/web/${entry}` : entry
    if (!existsSync(resolve(root, repoRelative))) {
      violations.push(`${configPath}: stale exact Web test entry ${JSON.stringify(normalizePath(entry))} does not exist`)
    }
  }
}

function isExactWebTestFileEntry(entry: string, prefix: string): boolean {
  if (!entry.startsWith(prefix) || entry.slice(prefix.length).includes('/')) return false
  if (/[?*{}[\]]/.test(entry)) return false
  return /\.(?:e2e|snapshot|acceptance|perf|spec|test)\.(?:ts|tsx)$/.test(entry)
}

function stringEntries(values: readonly unknown[] | undefined): Set<string> {
  return new Set((values ?? []).filter((value): value is string => typeof value === 'string').map(normalizePath))
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function discoverGestaltCompilerFaces(root: string): Record<ProjectFace, Set<string>> {
  const discovered: Record<ProjectFace, Set<string>> = { host: new Set(), client: new Set() }
  for (const config of globSync(GESTALT_PROJECT_PATTERNS, { cwd: root })) {
    const configPath = resolve(root, config)
    const face = projectFace(root, configPath, projectConfig(root, configPath))
    if (face === undefined) {
      throw new Error(`${repoPath(root, configPath)}: retained Gestalt project has no Host/Client face`)
    }
    discovered[face].add(repoPath(root, dirname(configPath)))
  }
  return discovered
}

function splitProjectRoots(root: string): string[] {
  return globSync(WORKSPACE_MANIFESTS, { cwd: root })
    .map(manifest => resolve(root, dirname(manifest)))
    .filter(dir => existsSync(resolve(dir, 'tsconfig.host.json'))
      && existsSync(resolve(dir, 'tsconfig.client.json')))
    .sort((left, right) => right.length - left.length)
}

function projectConfig(root: string, configPath: string): ProjectReferenceConfig {
  const read = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
  if (read.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(read.error.messageText, '\n')
    throw new Error(`${repoPath(root, configPath)}: ${message}`)
  }
  return read.config as ProjectReferenceConfig
}

function projectReferences(config: ProjectReferenceConfig): string[] {
  return (config.references ?? [])
    .map(reference => reference.path)
    .filter((path): path is string => typeof path === 'string')
}

function projectFace(
  root: string,
  configPath: string,
  config: ProjectReferenceConfig,
  seen = new Set<string>(),
): ProjectFace | undefined {
  if (basename(configPath) === 'tsconfig.host.json') return 'host'
  if (basename(configPath) === 'tsconfig.client.json') return 'client'
  if (configPath === resolve(root, 'tsconfig.base.json')) return 'host'
  if (configPath === resolve(root, 'tsconfig.base.client.json')) return 'client'
  if (seen.has(configPath)) return undefined
  seen.add(configPath)
  const parent = localExtendsConfig(configPath, config.extends)
  if (parent === undefined || !existsSync(parent)) return undefined
  return projectFace(root, parent, projectConfig(root, parent), seen)
}

function localExtendsConfig(configPath: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('.')) return undefined
  const target = resolve(dirname(configPath), value)
  return target.endsWith('.json') ? target : `${target}.json`
}

function referenceConfigPath(sourceConfig: string, reference: string): string {
  const target = resolve(dirname(sourceConfig), reference)
  return target.endsWith('.json') ? target : resolve(target, 'tsconfig.json')
}

function containingSplitRoot(splitRoots: readonly string[], targetConfig: string): string | undefined {
  return splitRoots.find((root) => {
    const path = relative(root, targetConfig)
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  })
}

function repoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function faceLabel(face: ProjectFace): string {
  return face === 'host' ? 'Host' : 'Client'
}
