/** Resolve one authoritative PowerShell availability decision for test processes. */
import { spawnSync } from 'node:child_process'
import { resolvePwshPath } from '../packages/shell/pwsh-local/src/resolve.ts'

/** Environment marker requiring PowerShell-backed tests to run instead of self-skipping. */
export const TEST_REQUIRE_PWSH_ENV = 'DSH_TEST_REQUIRE_PWSH'

/** Injectable process probe used by availability contract tests. */
export type PwshTestProbe = (executable: string, args: readonly string[]) => { status: number | null }

const probePwsh: PwshTestProbe = (executable, args) => spawnSync(executable, args, { encoding: 'utf8' })

/**
 * Decide whether PowerShell-backed tests must run in this process.
 * @param required - Explicit CI requirement; `1` bypasses repeat availability probes.
 * @param probe - Process probe used when the environment does not require PowerShell.
 * @returns whether real PowerShell tests should execute.
 */
export function testPwshAvailable(
  required: string | undefined = process.env[TEST_REQUIRE_PWSH_ENV],
  probe: PwshTestProbe = probePwsh,
): boolean {
  if (required !== undefined && required !== '' && required !== '1') {
    throw new Error(`${TEST_REQUIRE_PWSH_ENV} must be '1' or unset, got ${JSON.stringify(required)}.`)
  }
  if (required === '1') return true
  return probe(
    resolvePwshPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  ).status === 0
}
