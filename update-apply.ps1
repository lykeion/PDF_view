param([Parameter(Mandatory=$true)][string]$Job,[switch]$VerifyOnly)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Import-Module (Join-Path $PSHOME 'Modules\CimCmdlets\CimCmdlets.psd1')
$directory=$null;$stopped=$false;$changed=@();$newFiles=@();$jobData=$null
function Within([string]$base,[string]$candidate){$prefix=[IO.Path]::GetFullPath($base).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar;return [IO.Path]::GetFullPath($candidate).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)}
function NoLinks([string]$root,[string]$target){
 if(-not (Within $root $target)){throw 'Path escapes root'}
 $current=[IO.Path]::GetFullPath($target)
 while($current -and $current -ne $root){if(Test-Path -LiteralPath $current){if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked path is not allowed'}};$current=[IO.Path]::GetDirectoryName($current)}
}
function SafeName([string]$name){
 if($name.Contains('\') -or $name.Contains(':') -or @($name.Split('/')|Where-Object{$_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_.StartsWith('.')}).Count){return $false}
 return ($name -in $jobData.allowed -and $name -ne 'vendor') -or $name -cmatch '^[a-z][a-z0-9.-]*\.(mjs|cjs|js|ps1|html|css|svg|ico)$' -or $name -cmatch '^vendor/[A-Za-z0-9_./-]+$'
}
function HashFile([string]$file){$stream=[IO.File]::OpenRead($file);$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose();$stream.Dispose()}}
function StartServer {
 Start-Process -FilePath $jobData.node -ArgumentList @('"'+(Join-Path $jobData.root 'server.cjs')+'"') -WorkingDirectory $jobData.root -WindowStyle Hidden
}
try{
 $jobPath=[IO.Path]::GetFullPath($Job);$jobData=[IO.File]::ReadAllText($jobPath)|ConvertFrom-Json
 $root=[IO.Path]::GetFullPath($jobData.root).TrimEnd('\');$directory=[IO.Path]::GetFullPath($jobData.directory)
 $port=43187;if($jobData.port){$port=[int]$jobData.port;if($port -lt 1024 -or $port -gt 65535){throw 'Invalid port'}}
 if(-not (Within (Join-Path $root '.updates') $directory) -or $jobPath -ne (Join-Path $directory 'job.json')){throw 'Invalid update directory'}
 NoLinks $root $jobPath
 if([IO.Path]::GetFullPath($jobData.node) -ne [IO.Path]::GetFullPath((Get-Process -Id $jobData.serverPid -ErrorAction Stop).Path)){throw 'Unexpected runtime'}
 $manifest=Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw|ConvertFrom-Json
 $zipPath=Join-Path $directory 'update.zip'
 if((HashFile $zipPath) -ne $manifest.sha256){throw 'ZIP hash mismatch'}
 $staging=Join-Path $directory 'stage';$backup=Join-Path $directory 'backup'
 New-Item -ItemType Directory -Path $staging -Force|Out-Null
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 $archive=[IO.Compression.ZipFile]::OpenRead($zipPath)
 try{
  if($archive.Entries.Count -ne $manifest.files.Count){throw 'ZIP contains unexpected entries'}
  $seen=@{};$total=0L
  foreach($entry in $archive.Entries){
   $name=$entry.FullName
   if(-not (SafeName $name) -or $seen.ContainsKey($name.ToLowerInvariant())){throw 'Unsafe or duplicate ZIP entry'}
   $seen[$name.ToLowerInvariant()]=$true
   $record=@($manifest.files|Where-Object{$_.path -ceq $name})
   if($record.Count -ne 1 -or $entry.Length -ne $record[0].size -or $entry.Length -gt 100000000){throw 'Unexpected file size'}
   $total+=$entry.Length;if($total -gt 250000000){throw 'Expanded update is too large'}
   $target=[IO.Path]::GetFullPath((Join-Path $staging $name));NoLinks $staging $target
   [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
   [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)
   if((HashFile $target) -ne $record[0].sha256){throw 'File hash mismatch'}
  }
 }finally{$archive.Dispose()}
 $newRelease=Get-Content -LiteralPath (Join-Path $staging 'app-release.json') -Raw|ConvertFrom-Json
 if($newRelease.version -ne $jobData.version -or $manifest.version -ne $jobData.version){throw 'Version mismatch'}
 foreach($name in @('server.cjs','app.js','app-release.json','update-apply.ps1')){if(-not $seen.ContainsKey($name)){throw 'Missing required app file'}}
 if($VerifyOnly){@{verified=$true;files=$manifest.files.Count;version=$manifest.version}|ConvertTo-Json -Compress;exit 0}
 Start-Sleep -Seconds 2
 $owned=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$jobData.serverPid)
 if(-not $owned.CommandLine -or -not $owned.CommandLine.Contains((Join-Path $root 'server.cjs'))){throw 'Server ownership check failed'}
 Stop-Process -Id $jobData.serverPid -ErrorAction Stop
 Wait-Process -Id $jobData.serverPid -Timeout 10 -ErrorAction SilentlyContinue;$stopped=$true
 foreach($record in $manifest.files){
  $destination=[IO.Path]::GetFullPath((Join-Path $root $record.path));NoLinks $root $destination
  $source=Join-Path $staging $record.path;$saved=Join-Path $backup $record.path
  if(Test-Path -LiteralPath $destination){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved))|Out-Null;Copy-Item -LiteralPath $destination -Destination $saved -Force;$changed+=$record.path}else{$newFiles+=$record.path}
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))|Out-Null;Copy-Item -LiteralPath $source -Destination $destination -Force
 }
 StartServer
 $ready=$false
 for($attempt=0;$attempt -lt 40;$attempt++){Start-Sleep -Milliseconds 300;try{$health=Invoke-RestMethod ('http://127.0.0.1:'+$port+'/api/health') -TimeoutSec 2;if($health.release -eq $jobData.version){$ready=$true;break}}catch{}}
 if(-not $ready){throw 'Updated server did not become ready'}
 @{success=$true;version=$jobData.version}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $directory 'result.json') -Encoding UTF8
 # Keep one checked backup for recovery; personal files are never in this list.
}catch{
 if($stopped){
  try{
   $ownedAfter=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"|Where-Object{$_.CommandLine -and $_.CommandLine.Contains((Join-Path $jobData.root 'server.cjs'))})
   foreach($item in $ownedAfter){Stop-Process -Id $item.ProcessId -ErrorAction SilentlyContinue}
   foreach($name in $changed){$target=[IO.Path]::GetFullPath((Join-Path $jobData.root $name));NoLinks $jobData.root $target;Copy-Item -LiteralPath (Join-Path $directory ('backup/'+$name)) -Destination $target -Force}
   foreach($name in $newFiles){$target=[IO.Path]::GetFullPath((Join-Path $jobData.root $name));NoLinks $jobData.root $target;Remove-Item -LiteralPath $target -ErrorAction SilentlyContinue}
   StartServer
  }catch{}
 }
 if($directory -and (Test-Path -LiteralPath $directory)){@{success=$false;version=$jobData.version;error=$_.Exception.Message}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $directory 'result.json') -Encoding UTF8}
 Write-Error $_;exit 1
}
