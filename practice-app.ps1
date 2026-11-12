param([Parameter(Mandatory=$true)][string]$Url, [switch]$Inspect)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$address = [Uri]$Url
if ($address.Scheme -ne 'https' -or $address.Host -ne 'railnote.web.app' -or -not $address.IsDefaultPort -or $address.UserInfo) { throw 'Invalid practice URL' }
$shellObject = New-Object -ComObject WScript.Shell
$folders = @('Desktop','CommonDesktopDirectory','StartMenu','CommonStartMenu') | ForEach-Object { [Environment]::GetFolderPath($_) } | Select-Object -Unique
$plan = $null
foreach ($folder in $folders) {
    if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -match '(?i)railnote|레일노트' }) {
        $shortcut = $shellObject.CreateShortcut($file.FullName)
        if ([IO.Path]::GetFileName($shortcut.TargetPath) -notmatch '^(chrome_proxy|chrome|msedge_proxy|msedge)\.exe$' -or -not (Test-Path -LiteralPath $shortcut.TargetPath)) { continue }
        $arguments = $shortcut.Arguments
        $app = [regex]::Match($arguments, '(?:^|\s)--app-id=([a-p]{32})(?=\s|$)')
        if (-not $app.Success) { continue }
        $launchArguments = @('--app-id=' + $app.Groups[1].Value)
        foreach ($name in @('profile-directory','user-data-dir')) {
            $match = [regex]::Match($arguments, '(?:^|\s)--' + $name + '=(?:"([^"\r\n]+)"|([^\s"\r\n]+))')
            if ($match.Success) {
                $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
                $launchArguments += '--' + $name + '="' + $value + '"'
            }
        }
        $launchArguments += '--app-launch-url-for-shortcuts-menu-item="' + $address.AbsoluteUri + '"'
        $plan = @{installed=$true; executable=$shortcut.TargetPath; arguments=$launchArguments; shortcut=$file.FullName}
        break
    }
    if ($plan) { break }
}
if (-not $plan) { $plan = @{installed=$false} }
if ($Inspect) { $plan | ConvertTo-Json -Compress; exit 0 }
if ($plan.installed) {
    try {
        Start-Process -FilePath $plan.executable -ArgumentList $plan.arguments -WindowStyle Hidden
        @{opened=$true; mode='app'} | ConvertTo-Json -Compress
        exit 0
    } catch { }
}
Start-Process -FilePath $address.AbsoluteUri
@{opened=$true; mode='browser'} | ConvertTo-Json -Compress
