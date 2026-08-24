/** Reject proof-only identity, authority, and trust reachable from Companion product entries. */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const PRODUCT_ENTRIES = [
  'apps/desktop/src/main.ts',
  'apps/mobile/src/main.tsx',
  'apps/platform/src/boot.ts',
] as const
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
const FORBIDDEN = [
  { label: 'fixed GitHub fixture identity', pattern: /\boctocat\b/u },
  { label: 'a keyless product provider', pattern: /\b(?:DevelopmentKeyless\w*|\w*PERSONAL_PAIRING_KEYLESS)\b/u },
  { label: 'an in-memory product authority', pattern: /\bMemory(?:Account|PersonalPairing|Relay|PlatformCapacity)\w*\b/u },
  { label: 'the generic development/production selector', pattern: /\bloadPlatformEnvironment\b/u },
  { label: 'a development Platform identity', pattern: /\b(?:DSH|VITE)_PLATFORM_DEVELOPMENT_[A-Z_]+\b/u },
  { label: 'a proof-only Companion example', pattern: /(?:local-companion-platform|prototype-companion)/u },
  { label: 'a bundled development trust origin', pattern: /dev\.gestaltrun\.invalid/u },
  { label: 'a disabled certificate check', pattern: /rejectUnauthorized\s*:\s*false/u },
] as const

/**
 * Follow relative code imports and report proof-only product composition.
 * @param root - repository root or a fixture with the same product entries.
 * @returns stable path-and-line diagnostics.
 */
export function collectCompanionProductEntryResidue(root: string): string[] {
  const pending: ReachableModule[] = PRODUCT_ENTRIES.map(entry => ({ file: resolve(root, entry) }))
  const workspaces = workspaceSources(root)
  const fullyVisited = new Set<string>()
  const selectedVisited = new Map<string, Set<string>>()
  const failures = new Set<string>()
  while (pending.length > 0) {
    const reachable = pending.pop()
    if (reachable === undefined || !existsSync(reachable.file)) continue
    const selection = unvisitedSelection(reachable, fullyVisited, selectedVisited)
    if (selection === null) continue
    const file = reachable.file
    const source = readFileSync(file, 'utf8')
    const display = relative(root, file).split(sep).join('/')
    const analysis = analyzeModule(source, file, selection)
    source.split('\n').forEach((line, index) => {
      if (analysis.lines !== undefined && !analysis.lines.has(index + 1)) return
      const forbidden = FORBIDDEN.find(({ pattern }) => pattern.test(line))
      if (forbidden !== undefined) {
        failures.add(`${display}:${String(index + 1)}: contains ${forbidden.label}.`)
      }
    })
    for (const dependency of analysis.dependencies) {
      const dependencyFile = resolveCodeImport(workspaces, file, dependency.specifier)
      if (dependencyFile !== undefined) pending.push({
        file: dependencyFile,
        ...(dependency.exports === undefined ? {} : { exports: dependency.exports }),
      })
    }
  }
  return [...failures].sort()
}

interface ReachableModule {
  file: string
  exports?: ReadonlySet<string>
}

interface ModuleDependency {
  specifier: string
  exports?: ReadonlySet<string>
}

function unvisitedSelection(
  reachable: ReachableModule,
  fullyVisited: Set<string>,
  selectedVisited: Map<string, Set<string>>,
): ReadonlySet<string> | undefined | null {
  if (reachable.exports === undefined) {
    if (fullyVisited.has(reachable.file)) return null
    fullyVisited.add(reachable.file)
    selectedVisited.delete(reachable.file)
    return undefined
  }
  if (fullyVisited.has(reachable.file)) return null
  const visited = selectedVisited.get(reachable.file) ?? new Set<string>()
  const pending = new Set([...reachable.exports].filter(name => !visited.has(name)))
  if (pending.size === 0) return null
  for (const name of pending) visited.add(name)
  selectedVisited.set(reachable.file, visited)
  return pending
}

function analyzeModule(
  source: string,
  file: string,
  selection: ReadonlySet<string> | undefined,
): { lines?: ReadonlySet<number>; dependencies: ModuleDependency[] } {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const imports = new Map<string, { specifier: string; imported?: string }>()
  const declarations = new Map<string, ts.Statement>()
  const reexports = new Map<string, ModuleDependency>()
  const localExports = new Map<string, string>()
  const dependencies: ModuleDependency[] = []
  const effectStatements: ts.Statement[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)
      && statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (clause === undefined) dependencies.push({ specifier })
      if (clause?.name !== undefined) imports.set(clause.name.text, { specifier, imported: 'default' })
      const bindings = clause?.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        imports.set(bindings.name.text, { specifier })
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) {
            imports.set(element.name.text, { specifier, imported: element.propertyName?.text ?? element.name.text })
          }
        }
      }
      continue
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly
      && statement.moduleSpecifier === undefined && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          localExports.set(element.name.text, element.propertyName?.text ?? element.name.text)
        }
      }
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      const specifier = statement.moduleSpecifier.text
      if (statement.exportClause === undefined) {
        dependencies.push({
          specifier,
          ...(selection === undefined ? {} : { exports: selection }),
        })
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (selection === undefined || selection.has(statement.exportClause.name.text)) {
          dependencies.push({ specifier })
        }
      } else {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) {
            reexports.set(element.name.text, {
              specifier,
              exports: new Set([element.propertyName?.text ?? element.name.text]),
            })
          }
        }
      }
      continue
    }
    indexDeclaration(statement, declarations)
    if (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)) effectStatements.push(statement)
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    const specifier = match[1]
    if (specifier !== undefined) dependencies.push({ specifier })
  }
  if (selection === undefined) {
    for (const imported of imports.values()) {
      dependencies.push({
        specifier: imported.specifier,
        ...(imported.imported === undefined ? {} : { exports: new Set([imported.imported]) }),
      })
    }
    for (const dependency of reexports.values()) dependencies.push(dependency)
    return { dependencies }
  }
  const statements = new Set<ts.Statement>(effectStatements)
  const names = [...selection]
  const resolvedNames = new Set<string>()
  const identifiers = new Set<string>()
  for (const statement of effectStatements) collectIdentifiers(statement, identifiers)
  for (const identifier of identifiers) {
    if (declarations.has(identifier)) names.push(identifier)
  }
  while (names.length > 0) {
    const name = names.pop()
    if (name === undefined || resolvedNames.has(name)) continue
    resolvedNames.add(name)
    const reexport = reexports.get(name)
    if (reexport !== undefined) {
      dependencies.push(reexport)
      continue
    }
    const localExport = localExports.get(name)
    if (localExport !== undefined && localExport !== name) {
      names.push(localExport)
      continue
    }
    const imported = imports.get(name)
    if (imported !== undefined) {
      dependencies.push({
        specifier: imported.specifier,
        ...(imported.imported === undefined ? {} : { exports: new Set([imported.imported]) }),
      })
      continue
    }
    const statement = declarations.get(name)
    if (statement === undefined || statements.has(statement)) continue
    statements.add(statement)
    collectIdentifiers(statement, identifiers)
    for (const identifier of identifiers) {
      if (declarations.has(identifier)) names.push(identifier)
    }
  }
  for (const identifier of identifiers) {
    const imported = imports.get(identifier)
    if (imported === undefined) continue
    dependencies.push({
      specifier: imported.specifier,
      ...(imported.imported === undefined ? {} : { exports: new Set([imported.imported]) }),
    })
  }
  const lines = new Set<number>()
  for (const statement of statements) {
    const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
    const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1
    for (let line = start; line <= end; line += 1) lines.add(line)
  }
  return { lines, dependencies }
}

function indexDeclaration(statement: ts.Statement, declarations: Map<string, ts.Statement>): void {
  if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)) && statement.name !== undefined) {
    declarations.set(statement.name.text, statement)
    return
  }
  if (!ts.isVariableStatement(statement)) return
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement)
  }
}

function collectIdentifiers(node: ts.Node, identifiers: Set<string>): void {
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) identifiers.add(child.text)
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
}

function resolveCodeImport(
  workspaces: ReadonlyMap<string, string>,
  importer: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith('.')) return resolveWorkspaceImport(workspaces, specifier)
  const base = resolve(dirname(importer), specifier)
  if (SOURCE_EXTENSIONS.includes(extname(base) as (typeof SOURCE_EXTENSIONS)[number])) {
    return existsSync(base) ? base : undefined
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = base + extension
    if (existsSync(candidate)) return candidate
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = resolve(base, `index${extension}`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function workspaceSources(root: string): ReadonlyMap<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as unknown
  if (!isRecord(manifest) || !Array.isArray(manifest.workspaces)) return new Map()
  const packages = new Map<string, string>()
  for (const workspace of manifest.workspaces) {
    if (typeof workspace !== 'string') continue
    for (const file of globSync(`${workspace}/package.json`, { cwd: root })) {
      const value = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as unknown
      if (isRecord(value) && typeof value.name === 'string') packages.set(value.name, dirname(resolve(root, file)))
    }
  }
  return packages
}

function resolveWorkspaceImport(
  workspaces: ReadonlyMap<string, string>,
  specifier: string,
): string | undefined {
  const packageName = [...workspaces.keys()]
    .filter(name => specifier === name || specifier.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)[0]
  if (packageName === undefined) return undefined
  const packageRoot = workspaces.get(packageName)
  if (packageRoot === undefined) return undefined
  const subpath = specifier === packageName ? '' : specifier.slice(packageName.length + 1)
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as unknown
  const exported = isRecord(manifest) ? exportTarget(manifest.exports, subpath) : undefined
  const candidates = [
    ...(exported === undefined ? [] : sourceCandidates(resolve(packageRoot, exported))),
    ...sourceCandidates(resolve(packageRoot, subpath === '' ? 'src/index.ts' : `src/${subpath}.ts`)),
  ]
  return candidates.find(existsSync)
}

function exportTarget(exports: unknown, subpath: string): string | undefined {
  const key = subpath === '' ? '.' : `./${subpath}`
  const selected = isRecord(exports) && key in exports ? exports[key] : subpath === '' ? exports : undefined
  if (typeof selected === 'string') return selected
  if (!isRecord(selected)) return undefined
  return typeof selected.default === 'string'
    ? selected.default
    : typeof selected.import === 'string'
      ? selected.import
      : undefined
}

function sourceCandidates(path: string): string[] {
  const sourcePath = path.replace(`${sep}lib${sep}`, `${sep}src${sep}`)
  const withoutExtension = sourcePath.replace(/\.(?:mjs|cjs|js)$/u, '')
  return [sourcePath, ...SOURCE_EXTENSIONS.map(extension => withoutExtension + extension)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const failures = collectCompanionProductEntryResidue(ROOT)
  if (failures.length > 0) {
    process.stderr.write('verify-companion-product-entry: proof-only product composition found:\n')
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-companion-product-entry: product entries reach only operated composition.\n')
}
