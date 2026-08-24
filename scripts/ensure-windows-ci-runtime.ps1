# Revalidate the native resolver binding and repair only its signed Microsoft runtime prerequisite.
$ErrorActionPreference = 'Stop'

function Test-OxcResolverBinding {
  $probeErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node -e "require('oxc-resolver')" 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $probeErrorActionPreference
  }
}

if (Test-OxcResolverBinding) {
  Write-Host 'ensure-windows-ci-runtime: native resolver binding is ready.'
  exit 0
}

$runtimeInstaller = Join-Path $env:RUNNER_TEMP 'vc_redist.x64.exe'
$runtimeUri = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
try {
  Invoke-WebRequest -Uri $runtimeUri -OutFile $runtimeInstaller
  $runtimeSignature = Get-AuthenticodeSignature -FilePath $runtimeInstaller
  if ($runtimeSignature.Status -ne 'Valid'
    -or $null -eq $runtimeSignature.SignerCertificate
    -or $runtimeSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "Microsoft Visual C++ Redistributable signature validation failed: $($runtimeSignature.Status) $($runtimeSignature.StatusMessage)"
  }

  $runtimeProcess = Start-Process -FilePath $runtimeInstaller -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  if ($runtimeProcess.ExitCode -notin 0, 1638, 3010) {
    throw "Microsoft Visual C++ Redistributable installer exited $($runtimeProcess.ExitCode)."
  }
  if (-not (Test-OxcResolverBinding)) {
    throw 'native resolver binding remains unavailable after installing the Microsoft Visual C++ Redistributable.'
  }
  Write-Host 'ensure-windows-ci-runtime: installed the signed Microsoft Visual C++ runtime and loaded the native resolver binding.'
} finally {
  Remove-Item -LiteralPath $runtimeInstaller -Force -ErrorAction SilentlyContinue
}
