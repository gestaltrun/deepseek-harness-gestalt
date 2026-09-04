/** Validate compiler-face isolation across workspace Project Reference graphs. */

import { existsSync, globSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export type ProjectFace = 'host' | 'client'

export const GESTALT_COMPILER_FACES: Readonly<Record<ProjectFace, readonly string[]>> = {
  host: [
    'apps/desktop',
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
  readonly references?: ReadonlyArray<{ readonly path?: unknown }>
}

const WORKSPACE_MANIFESTS = [
  'packages/*/*/package.json',
  'apps/*/package.json',
  'vendor/*/package.json',
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
  const violations = collectGestaltCompilerFaceViolations(root)
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
export function collectGestaltCompilerFaceViolations(root: string): string[] {
  const violations: string[] = []
  for (const face of ['host', 'client'] as const) {
    const aggregate = resolve(root, `tsconfig.${face}.json`)
    const references = new Set(projectReferences(projectConfig(root, aggregate))
      .map(reference => referenceConfigPath(aggregate, reference)))
    for (const directory of GESTALT_COMPILER_FACES[face]) {
      const expected = resolve(root, directory, 'tsconfig.json')
      if (!existsSync(expected)) continue
      if (!references.has(expected)) {
        violations.push(`${directory}/tsconfig.json: retained Gestalt project is omitted from the root ${faceLabel(face)} aggregate`)
      }
    }
  }
  return violations.sort()
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
