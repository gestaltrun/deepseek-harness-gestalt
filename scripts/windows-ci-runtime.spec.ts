import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const runtimeScript = readFileSync(resolve(import.meta.dirname, 'ensure-windows-ci-runtime.ps1'), 'utf8')

describe('Windows CI native runtime provisioning', () => {
  it('executes the resolver probe before and after a signed Microsoft runtime install', () => {
    expect(runtimeScript.match(/Test-OxcResolverBinding/gu)).toHaveLength(3)
    expect(runtimeScript).toContain('$ErrorActionPreference = \'Continue\'')
    expect(runtimeScript).toContain('$ErrorActionPreference = $probeErrorActionPreference')
    expect(runtimeScript).toContain('https://aka.ms/vs/17/release/vc_redist.x64.exe')
    expect(runtimeScript).toContain('Get-AuthenticodeSignature')
    expect(runtimeScript).toContain('$runtimeSignature.Status -ne \'Valid\'')
    expect(runtimeScript).toContain('O=Microsoft Corporation')
    expect(runtimeScript).toContain('\'/install\', \'/quiet\', \'/norestart\'')
    expect(runtimeScript).toContain('$runtimeProcess.ExitCode -notin 0, 1638, 3010')
    expect(runtimeScript).toContain('Remove-Item -LiteralPath $runtimeInstaller')
  })
})
