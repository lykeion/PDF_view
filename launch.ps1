$ErrorActionPreference = 'Stop'
$viewerUrl = 'http://127.0.0.1:43187'
$viewerIdentity = 'paper-local-pdf-viewer'
$viewerRoot = $PSScriptRoot
$serverPath = Join-Path $viewerRoot 'server.cjs'
$rootHash = [Security.Cryptography.SHA256]::Create()
$viewerInstance = ([BitConverter]::ToString($rootHash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($viewerRoot).ToLowerInvariant())))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
$rootHash.Dispose()

function Get-ViewerState {
    try {
        $response = Invoke-WebRequest -Uri "$viewerUrl/api/health" -UseBasicParsing -TimeoutSec 2
        $health = $response.Content | ConvertFrom-Json
        if ($health.app -eq $viewerIdentity -and $health.version -eq 1 -and $health.instance -eq $viewerInstance) { return 'ready' }
        return 'occupied'
    } catch {
        if ($_.Exception.Response) { return 'occupied' }
        return 'unavailable'
    }
}

try {
    $state = Get-ViewerState
    if ($state -eq 'occupied') { throw 'Port 43187 belongs to another application. Close that application before starting this viewer.' }
    if ($state -ne 'ready') {
        $localNode = Join-Path $viewerRoot 'runtime\node.exe'
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        $nodePath = if (Test-Path -LiteralPath $localNode -PathType Leaf) { $localNode } elseif ($nodeCommand) { $nodeCommand.Source } else { $null }
        if (-not $nodePath) {
            $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
            if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $nodePath = $bundledNode }
        }
        if (-not $nodePath) { throw 'Node.js could not be found. Install Node.js or restore the Codex bundled runtime.' }
        $viewerProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $viewerRoot -WindowStyle Hidden -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 200
            $state = Get-ViewerState
            if ($state -eq 'ready') { $ready = $true; break }
            if ($state -eq 'occupied') { throw 'Port 43187 belongs to another application. The viewer was not opened.' }
            if ($viewerProcess.HasExited) { throw 'The local viewer server could not start. Port 43187 may already be in use.' }
        }
        if (-not $ready) { throw 'The viewer server did not become ready. Please try again.' }
    }

    $chromeCandidates = @()
    if ($env:ProgramFiles) { $chromeCandidates += Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe' }
    if (${env:ProgramFiles(x86)}) { $chromeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }
    if ($env:LOCALAPPDATA) { $chromeCandidates += Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' }
    $chromePath = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

    $edgeCandidates = @()
    if (${env:ProgramFiles(x86)}) { $edgeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe' }
    if ($env:ProgramFiles) { $edgeCandidates += Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
    if ($env:LOCALAPPDATA) { $edgeCandidates += Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe' }
    $edgePath = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    $browserPath = if ($chromePath) { $chromePath } else { $edgePath }
    if ($browserPath) {
        # A regular Chrome process ignores fullscreen flags from later launches.
        # Keep this reader in its own process/profile so every app window inherits
        # the fullscreen startup flag, including when ordinary Chrome is open.
        $browserName = if ($chromePath) { 'chrome' } else { 'edge' }
        $profilePath = Join-Path $viewerRoot ('.browser-profile\' + $browserName)
        $migrationMarker = Join-Path $profilePath 'reader-state-imported.json'
        New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
        $openUrl = $viewerUrl
        $transfer = $null
        if (-not (Test-Path -LiteralPath $migrationMarker -PathType Leaf)) {
            try {
                # Export only this local reader's history and last PDF, through
                # its own origin. No general Chrome profile files are accessed.
                $transfer = Invoke-RestMethod -Uri "$viewerUrl/api/handoff" -Method Post -ContentType 'application/json' -Headers @{'X-Viewer-Handoff'='1'} -Body '{}' -TimeoutSec 3
                if ($transfer.token -notmatch '^[a-f0-9]{64}$') { throw 'Invalid reader transfer token.' }
                $exportUrl = "$viewerUrl/handoff.html?token=$($transfer.token)&mode=export"
                Start-Process -FilePath $browserPath -ArgumentList @('--no-first-run', '--no-default-browser-check', ('--app=' + $exportUrl)) -WindowStyle Normal
                $transferReady = $false
                for ($attempt = 0; $attempt -lt 80; $attempt++) {
                    $transferState = Invoke-RestMethod -Uri "$viewerUrl/api/handoff/$($transfer.token)/status" -TimeoutSec 2
                    if ($transferState.ready) { $transferReady = $true; break }
                    Start-Sleep -Milliseconds 250
                }
                if ($transferReady) { $openUrl = "$viewerUrl/handoff.html?token=$($transfer.token)&mode=import" }
            } catch {
                # The existing browser's saved data remains untouched. A failed
                # handoff must never prevent opening the local reader.
                $transfer = $null
            }
        }
        # This is the visible interactive viewer requested by the user.
        $browserArgs = @(
            ('"--user-data-dir=' + $profilePath + '"'),
            '--no-first-run', '--no-default-browser-check',
            '--start-fullscreen', '--start-maximized', ('--app=' + $openUrl)
        )
        Start-Process -FilePath $browserPath -ArgumentList $browserArgs -WindowStyle Normal
        if ($transfer -and $transferReady) {
            try {
                for ($attempt = 0; $attempt -lt 80; $attempt++) {
                    $transferState = Invoke-RestMethod -Uri "$viewerUrl/api/handoff/$($transfer.token)/status" -TimeoutSec 2
                    if ($transferState.imported) {
                        @{version=1; importedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $migrationMarker -Encoding UTF8
                        break
                    }
                    Start-Sleep -Milliseconds 250
                }
            } catch { }
        }
    } else {
        Start-Process -FilePath $viewerUrl
    }
} catch {
    Write-Host ''
    Write-Host ('PDF viewer: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 1
}
