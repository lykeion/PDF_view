param([Parameter(Mandatory=$true)][string]$Job)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PdfGptNative {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static void Chord(byte key){keybd_event(0x11,0,0,UIntPtr.Zero);keybd_event(key,0,0,UIntPtr.Zero);keybd_event(key,0,2,UIntPtr.Zero);keybd_event(0x11,0,2,UIntPtr.Zero);}
 public static void Enter(){keybd_event(0x0D,0,0,UIntPtr.Zero);keybd_event(0x0D,0,2,UIntPtr.Zero);}
}
'@
function Result([bool]$prepared,[string]$reason){@{prepared=$prepared;reason=$reason}|ConvertTo-Json -Compress}
function Elements($parent,$type){$parent.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type))}
function BrowserWindows {
 foreach($element in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)){
  try{if((Get-Process -Id $element.Current.ProcessId -ErrorAction Stop).ProcessName -in @('chrome','msedge') -and $element.Current.Name -notmatch 'PDF 뷰어'){Write-Output $element}}catch{}
 }
}
function Raise($window){$handle=[IntPtr]$window.Current.NativeWindowHandle;if([PdfGptNative]::IsIconic($handle)){[void][PdfGptNative]::ShowWindow($handle,9)};[void][PdfGptNative]::SetForegroundWindow($handle);Start-Sleep -Milliseconds 200}
function AddressBar($window){
 $bar=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'view_1012'))
 if($bar){return $bar}
 foreach($edit in Elements $window ([Windows.Automation.ControlType]::Edit)){if($edit.Current.Name -match '주소창|Address and search bar|Search or enter web'){return $edit}}
 return $null
}
function Address($window){$bar=AddressBar $window;$pattern=$null;if($bar -and $bar.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){return $pattern.Current.Value};return ''}
function IsProject($window){$value=Address $window;return ($value -replace '^https://','').TrimEnd('/') -eq ($script:projectUrl -replace '^https://','').TrimEnd('/')}
function Composer($window){
 $document=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'RootWebArea'))
 if(-not $document){return $null}
 $edits=@(Elements $document ([Windows.Automation.ControlType]::Edit)|Where-Object{$_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and -not $_.Current.IsPassword})
 foreach($edit in $edits){if($edit.Current.AutomationId -eq 'prompt-textarea' -or $edit.Current.Name -eq ($script:projectName+'의 새 채팅') -or $edit.Current.Name -match '^Ask anything$|^Message ChatGPT$|^무엇이든 물어보세요$'){return $edit}}
 return $null
}
function Content($composer){$pattern=$null;if($composer.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){return $pattern.Current.Value};if($composer.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){return $pattern.DocumentRange.GetText(-1)};return ''}
function AssertFocus($window,$element){
 if([PdfGptNative]::GetForegroundWindow().ToInt64() -ne $window.Current.NativeWindowHandle){throw 'focus-changed'}
 $element.SetFocus();Start-Sleep -Milliseconds 100
 $focus=[Windows.Automation.AutomationElement]::FocusedElement;$walker=[Windows.Automation.TreeWalker]::RawViewWalker;$matched=$false
 for($i=0;$i -lt 8 -and $focus;$i++){if([Windows.Automation.Automation]::Compare($focus,$element)){$matched=$true;break};$focus=$walker.GetParent($focus)}
 if(-not $matched -or [PdfGptNative]::GetForegroundWindow().ToInt64() -ne $window.Current.NativeWindowHandle){throw 'focus-changed'}
}
$stage='start'
try{
 $root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.gpt-transfer'))+[IO.Path]::DirectorySeparatorChar
 $jobPath=[IO.Path]::GetFullPath($Job);if(-not $jobPath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'invalid-job'}
 $data=[IO.File]::ReadAllText($jobPath)|ConvertFrom-Json
 $imagePath=[IO.Path]::GetFullPath($data.imagePath);if(-not $imagePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'invalid-image'}
 if(-not $data.project){Result $false 'project-required';exit 0}
 $script:projectName=[string]$data.project.name;$script:projectUrl=[string]$data.project.url
 if($script:projectUrl -notmatch '^https://chatgpt\.com/g/g-p-[a-zA-Z0-9_-]+/project/?$'){throw 'invalid-project'}
 $stage='browser';$window=$null
 foreach($candidate in BrowserWindows){if($candidate.Current.Name -match 'ChatGPT' -and (Address $candidate) -match '^(https://)?chatgpt\.com(?:/|$)'){$window=$candidate;break}}
 if(-not $window){
  foreach($candidate in BrowserWindows){
   foreach($tab in Elements $candidate ([Windows.Automation.ControlType]::TabItem)){
    if($tab.Current.Name -match 'ChatGPT'){$pattern=$null;if($tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){Raise $candidate;$pattern.Select();$window=$candidate;break}}
   };if($window){break}
  }
 }
 if(-not $window){
  $browser=@((Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),(Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),(Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),(Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'))|Where-Object{Test-Path -LiteralPath $_}|Select-Object -First 1
  if(-not $browser){Result $false 'browser-unavailable';exit 0}
  Start-Process -FilePath $browser -ArgumentList @($script:projectUrl) -WindowStyle Normal
  for($attempt=0;$attempt -lt 30 -and -not $window;$attempt++){Start-Sleep -Milliseconds 500;foreach($candidate in BrowserWindows){if((Address $candidate) -match '^(https://)?chatgpt\.com(?:/|$)'){$window=$candidate;break}}}
 }
 if(-not $window){Result $false 'browser-unavailable';exit 0}
 Raise $window;$stage='project'
 if(-not (IsProject $window)){
  $bar=AddressBar $window;if(-not $bar){throw 'address-bar-unavailable'}
  AssertFocus $window $bar
  [Windows.Forms.Clipboard]::SetText($script:projectUrl);[PdfGptNative]::Chord(0x41);[PdfGptNative]::Chord(0x56);Start-Sleep -Milliseconds 100
  AssertFocus $window $bar;[PdfGptNative]::Enter()
 }
 $composer=$null
 for($attempt=0;$attempt -lt 40;$attempt++){Start-Sleep -Milliseconds 350;if(IsProject $window){$composer=Composer $window;if($composer){break}}}
 if(-not $composer){Result $false 'login-or-composer-unavailable';exit 0}
 $existing=[string](Content $composer)
 if(-not [string]::IsNullOrWhiteSpace($existing) -and $existing.Trim() -ne $composer.Current.Name.Trim()){Result $false 'draft-not-empty';exit 0}
 $stage='image';AssertFocus $window $composer
 $image=[Drawing.Image]::FromFile($imagePath)
 try{$bitmap=[Drawing.Bitmap]::new($image);try{[Windows.Forms.Clipboard]::SetImage($bitmap)}finally{$bitmap.Dispose()}}finally{$image.Dispose()}
 [PdfGptNative]::Chord(0x56)
 $attachment=$null
 for($attempt=0;$attempt -lt 25;$attempt++){
  Start-Sleep -Milliseconds 200
  $attachment=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'image.png'))
  if($attachment -and -not $attachment.Current.IsOffscreen){break}
 }
 if(-not $attachment){Result $false 'image-unverified';exit 0}
 $stage='question';$composer=Composer $window;if(-not $composer){throw 'composer-unavailable'}
 AssertFocus $window $composer
 [Windows.Forms.Clipboard]::SetText([string]$data.prompt);[PdfGptNative]::Chord(0x56);Start-Sleep -Milliseconds 400
 $composer=Composer $window
 if(-not $composer -or -not ([string](Content $composer)).Contains([string]$data.prompt)){Result $false 'input-unverified';exit 0}
 Result $true 'draft-prepared'
}catch{Result $false ($stage+':'+$_.Exception.Message)}
