param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version
)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:RUNNER_TEMP "ccb-release-smoke"
$target = Join-Path $root "install"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$setup = Start-Process -FilePath $installerPath -ArgumentList "/S", "/D=$target" -Wait -PassThru -WindowStyle Hidden
if ($setup.ExitCode -ne 0) { throw "NSIS install failed with exit code $($setup.ExitCode)" }
$exe = Join-Path $target "cc-bridge-desktop.exe"
if (!(Test-Path -LiteralPath $exe)) { throw "NSIS did not install the application binary" }

function Wait-Bridge {
    param([int]$PreviousPid)
    for ($i = 0; $i -lt 35; $i++) {
        $candidate = Get-Process -Name cc-bridge-desktop -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $exe -and $_.Id -ne $PreviousPid } | Select-Object -First 1
        try { $health = Invoke-RestMethod "http://127.0.0.1:7823/health" -TimeoutSec 2 } catch { $health = $null }
        if ($candidate -and $health.version -eq $Version) { return }
        Start-Sleep -Seconds 1
    }
    throw "Installed application did not start as version $Version"
}

$env:CCBRIDGE_SKIP_FORCE_UPDATE = "1"
$app = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
$updateSetup = $null
try {
    Wait-Bridge -PreviousPid 0
    $updateSetup = Start-Process -FilePath $installerPath -ArgumentList "/P", "/UPDATE", "/R", "/CCBUPDATEPID=$($app.Id)", "/D=$target" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
    if ($app.HasExited -or $updateSetup.HasExited) { throw "The updater did not wait for CC Bridge to close" }
    # The application does its own graceful shutdown in production. The runner releases
    # this process explicitly to verify the installer waits, replaces, and relaunches it.
    Stop-Process -Id $app.Id -Force
    $app.WaitForExit()
    if (!$updateSetup.WaitForExit(60000) -or $updateSetup.ExitCode -ne 0) { throw "Update installer did not finish successfully" }
    Wait-Bridge -PreviousPid $app.Id
} finally {
    if ($updateSetup -and !$updateSetup.HasExited) { Stop-Process -Id $updateSetup.Id -Force }
    Get-Process -Name cc-bridge-desktop -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $exe } | Stop-Process -Force
}
