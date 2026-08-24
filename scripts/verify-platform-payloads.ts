/** Verify that a clean install materialized the current host's executable payloads. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

interface PackageManifest {
  readonly bin?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

function manifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function assertDeclared(
  owner: string,
  dependencies: Readonly<Record<string, string>> | undefined,
  name: string,
): void {
  if (dependencies?.[name] === undefined) {
    throw new Error(`verify-platform-payloads: ${owner} does not declare ${name}.`)
  }
}

function runVersion(command: string, args: readonly string[], label: string): string {
  const stdout = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim()
  if (stdout.length === 0) {
    throw new Error(`verify-platform-payloads: ${label} produced no version output.`)
  }
  return stdout
}

/** Execute both official native CLI payloads selected for the current host. */
export function verifyPlatformPayloads(): { codex: string; claude: string } {
  const codexManifestPath = resolve(
    root,
    'packages/subagent/subagent-codex/node_modules/@openai/codex/package.json',
  )
  const codexManifest = manifest(codexManifestPath)
  const codexPlatform = `@openai/codex-${process.platform}-${process.arch}`
  assertDeclared('@openai/codex', codexManifest.optionalDependencies, codexPlatform)
  const codexEntry = codexManifest.bin?.codex
  if (codexEntry === undefined) {
    throw new Error('verify-platform-payloads: @openai/codex declares no codex executable.')
  }
  const codex = runVersion(
    process.execPath,
    [resolve(dirname(codexManifestPath), codexEntry), '--version'],
    codexPlatform,
  )

  const claudeManifestPath = resolve(
    root,
    'packages/subagent/subagent-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  )
  const claudeManifest = manifest(claudeManifestPath)
  const claudePlatform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  assertDeclared('@anthropic-ai/claude-agent-sdk', claudeManifest.optionalDependencies, claudePlatform)
  const sdkDirectory = realpathSync(dirname(claudeManifestPath))
  const claudeExecutable = resolve(
    dirname(sdkDirectory),
    basename(claudePlatform),
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  if (!existsSync(claudeExecutable)) {
    throw new Error(`verify-platform-payloads: ${claudePlatform} executable is absent.`)
  }
  const claude = runVersion(claudeExecutable, ['--version'], claudePlatform)
  return { codex, claude }
}

if (import.meta.main) {
  const versions = verifyPlatformPayloads()
  console.log(`verify-platform-payloads: Codex ${versions.codex}; Claude ${versions.claude}.`)
}
