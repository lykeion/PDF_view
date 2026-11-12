param(
    [string]$WindowToken,
    [string]$ProfileRoot = (Join-Path $PSScriptRoot '.browser-profile'),
    [ValidateSet('Restore', 'Enter', 'Icon')]
    [string]$Action = 'Restore'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Result([bool]$Restored, [string]$Reason) {
    @{ restored = $Restored; reason = $Reason } | ConvertTo-Json -Compress
}

try {
    if ($WindowToken -cnotmatch '^[a-f0-9]{32}$' -or -not [IO.Path]::IsPathRooted($ProfileRoot)) {
        Write-Result $false 'invalid-input'
        exit 0
    }
    $resolvedProfileRoot = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expectedTitle = 'PDF Viewer [' + $WindowToken + ']'

    # This helper changes only this reader's nonce-titled app window. It never
    # sends keys, focuses another app, or closes processes.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NaranhiNativeWindow {
    private delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLong64(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message,
        UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("shell32.dll")]
    private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey {
        public Guid format;
        public uint id;
        public PropertyKey(uint propertyId) {
            format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            id = propertyId;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant {
        public ushort type;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public IntPtr value;
        public IntPtr unionPadding;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    private static void SetString(IPropertyStore store, uint id, string text) {
        PropertyKey key = new PropertyKey(id);
        PropVariant value = new PropVariant();
        value.type = 31; // VT_LPWSTR; the window property store copies the value.
        value.value = Marshal.StringToCoTaskMemUni(text);
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); }
        finally { PropVariantClear(ref value); }
    }

    private static string GetString(IPropertyStore store, uint id) {
        PropertyKey key = new PropertyKey(id);
        PropVariant value = new PropVariant();
        try {
            Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
            return value.type == 31 ? Marshal.PtrToStringUni(value.value) : null;
        } finally { PropVariantClear(ref value); }
    }

    public static bool SetTaskbarIcon(IntPtr hwnd, string command, string iconPath,
        string displayName, string appId) {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd, ref iid, out store));
        try {
            string iconResource = iconPath + ",0";
            SetString(store, 2, command);
            SetString(store, 3, iconResource);
            SetString(store, 4, displayName);
            // Setting the explicit ID last notifies the taskbar to refresh.
            SetString(store, 5, appId);
            // SetValue stores values on the HWND immediately; Commit is not
            // needed. No HICON or helper process must stay alive afterwards.
            return String.Equals(GetString(store, 2), command, StringComparison.Ordinal)
                && String.Equals(GetString(store, 3), iconResource, StringComparison.Ordinal)
                && String.Equals(GetString(store, 4), displayName, StringComparison.Ordinal)
                && String.Equals(GetString(store, 5), appId, StringComparison.Ordinal);
        } finally { Marshal.ReleaseComObject(store); }
    }

    public static string[] Arguments(string commandLine) {
        int count;
        IntPtr buffer = CommandLineToArgvW(commandLine, out count);
        if (buffer == IntPtr.Zero) throw new InvalidOperationException("Cannot parse browser arguments.");
        try {
            string[] values = new string[count];
            for (int i = 0; i < count; i++) {
                values[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, i * IntPtr.Size));
            }
            return values;
        } finally { LocalFree(buffer); }
    }

    public static uint ProcessId(IntPtr hwnd) {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        return processId;
    }

    public static bool Matches(IntPtr hwnd, string title, uint processId) {
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return false;
        if (processId != 0 && ProcessId(hwnd) != processId) return false;
        StringBuilder className = new StringBuilder(256);
        GetClassName(hwnd, className, className.Capacity);
        if (!String.Equals(className.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return false;
        StringBuilder windowTitle = new StringBuilder(512);
        GetWindowText(hwnd, windowTitle, windowTitle.Capacity);
        return String.Equals(windowTitle.ToString(), title, StringComparison.Ordinal);
    }

    public static IntPtr[] Find(string title) {
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (Matches(hwnd, title, 0)) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool HasCaption(IntPtr hwnd) {
        // Chromium removes WS_CAPTION for native fullscreen.
        long style = IntPtr.Size == 8 ? GetWindowLong64(hwnd, -16).ToInt64() : GetWindowLong32(hwnd, -16);
        return (style & 0x00C00000L) == 0x00C00000L;
    }

    public static bool IsFramedMaximized(IntPtr hwnd) {
        // IsZoomed alone does not distinguish fullscreen from maximized.
        return HasCaption(hwnd) && IsZoomed(hwnd);
    }

    public static bool ToggleFullscreen(IntPtr hwnd) {
        // WM_COMMAND / IDC_FULLSCREEN goes through Chrome's fullscreen
        // controller, clearing its logical state as well as its native frame.
        // Only call this after checking the current caption state.
        UIntPtr result;
        return SendMessageTimeout(hwnd, 0x0111, new UIntPtr(34030), IntPtr.Zero,
            0x0002 | 0x0020, 2000, out result) != IntPtr.Zero;
    }

    public static bool Maximize(IntPtr hwnd) {
        // WM_COMMAND / IDC_MAXIMIZE_WINDOW, after fullscreen has been exited.
        UIntPtr result;
        return SendMessageTimeout(hwnd, 0x0111, new UIntPtr(34047), IntPtr.Zero,
            0x0002 | 0x0020, 2000, out result) != IntPtr.Zero;
    }
}
'@ | Out-Null

    $candidateWindows = @([NaranhiNativeWindow]::Find($expectedTitle))
    if ($candidateWindows.Count -ne 1) {
        $reason = if ($candidateWindows.Count -eq 0) { 'window-not-found' } else { 'ambiguous-window' }
        Write-Result $false $reason
        exit 0
    }
    $readerHandle = $candidateWindows[0]
    $browserProcessId = [NaranhiNativeWindow]::ProcessId($readerHandle)
    $browserProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $browserProcessId) -ErrorAction Stop
    if (-not $browserProcess -or -not $browserProcess.CommandLine -or -not $browserProcess.ExecutablePath) {
        Write-Result $false 'browser-process-unavailable'
        exit 0
    }
    $browserExecutable = [IO.Path]::GetFileName($browserProcess.ExecutablePath)
    if ($browserExecutable -ieq 'chrome.exe' -and $browserProcess.Name -ieq 'chrome.exe') {
        $browserFolder = 'chrome'
    } elseif ($browserExecutable -ieq 'msedge.exe' -and $browserProcess.Name -ieq 'msedge.exe') {
        $browserFolder = 'edge'
    } else {
        Write-Result $false 'unsupported-browser-process'
        exit 0
    }

    $browserArguments = @([NaranhiNativeWindow]::Arguments($browserProcess.CommandLine))
    $profileArguments = @()
    for ($index = 1; $index -lt $browserArguments.Count; $index++) {
        $argument = $browserArguments[$index]
        if ($argument -ieq '--type' -or $argument.StartsWith('--type=', [StringComparison]::OrdinalIgnoreCase)) {
            Write-Result $false 'not-browser-main-process'
            exit 0
        }
        if ($argument.StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) {
            $profileArguments += $argument.Substring('--user-data-dir='.Length)
        } elseif ($argument -ieq '--user-data-dir') {
            if ($index + 1 -lt $browserArguments.Count) {
                $index++
                $profileArguments += $browserArguments[$index]
            }
        }
    }
    if ($profileArguments.Count -ne 1 -or -not [IO.Path]::IsPathRooted($profileArguments[0])) {
        Write-Result $false 'profile-not-matched'
        exit 0
    }
    $browserProfile = [IO.Path]::GetFullPath($profileArguments[0]).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expectedProfile = [IO.Path]::GetFullPath((Join-Path $resolvedProfileRoot $browserFolder)).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $browserProfile.Equals($expectedProfile, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Result $false 'profile-not-matched'
        exit 0
    }

    # Recheck after process lookup: the requesting tab may have navigated or
    # closed, or its HWND may have been recycled while the lookup was running.
    if (-not [NaranhiNativeWindow]::Matches($readerHandle, $expectedTitle, $browserProcessId)) {
        Write-Result $false 'window-changed'
        exit 0
    }
    if ($Action -eq 'Icon') {
        $viewerRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $iconPath = Join-Path $viewerRoot 'app-icon.ico'
        $launcherPath = Join-Path $viewerRoot 'launch.ps1'
        if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf) -or -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
            Write-Result $false 'icon-resource-missing'
            exit 0
        }
        $rootHasher = [Security.Cryptography.SHA256]::Create()
        try {
            $rootDigest = $rootHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($viewerRoot.ToLowerInvariant()))
            $appId = 'LocalPDFViewer.' + ([BitConverter]::ToString($rootDigest)).Replace('-', '').Substring(0, 16).ToLowerInvariant()
        } finally { $rootHasher.Dispose() }
        $powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $relaunchCommand = '"' + $powershellPath + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
        $displayName = 'PDF ' + [char]0xBDF0 + [char]0xC5B4
        if (-not [NaranhiNativeWindow]::Matches($readerHandle, $expectedTitle, $browserProcessId)) {
            Write-Result $false 'window-changed'
            exit 0
        }
        if ([NaranhiNativeWindow]::SetTaskbarIcon($readerHandle, $relaunchCommand, $iconPath, $displayName, $appId)) {
            @{ restored = $true; reason = 'icon-updated'; iconPath = $iconPath; appId = $appId } | ConvertTo-Json -Compress
        } else {
            Write-Result $false 'icon-properties-not-confirmed'
        }
        exit 0
    }
    if ($Action -eq 'Enter') {
        if (-not [NaranhiNativeWindow]::HasCaption($readerHandle)) {
            Write-Result $true 'already-fullscreen'
            exit 0
        }
        if (-not [NaranhiNativeWindow]::ToggleFullscreen($readerHandle)) {
            Write-Result $false 'fullscreen-command-timeout'
            exit 0
        }
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if (-not [NaranhiNativeWindow]::Matches($readerHandle, $expectedTitle, $browserProcessId)) {
                Write-Result $false 'window-changed'
                exit 0
            }
            if (-not [NaranhiNativeWindow]::HasCaption($readerHandle)) {
                Write-Result $true 'fullscreen'
                exit 0
            }
            Start-Sleep -Milliseconds 50
        }
        Write-Result $false 'fullscreen-enter-not-confirmed'
        exit 0
    }
    if ([NaranhiNativeWindow]::IsFramedMaximized($readerHandle)) {
        Write-Result $true 'already-maximized'
        exit 0
    }
    if (-not [NaranhiNativeWindow]::HasCaption($readerHandle)) {
        if (-not [NaranhiNativeWindow]::ToggleFullscreen($readerHandle)) {
            Write-Result $false 'fullscreen-command-timeout'
            exit 0
        }
        $fullscreenExited = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if (-not [NaranhiNativeWindow]::Matches($readerHandle, $expectedTitle, $browserProcessId)) {
                Write-Result $false 'window-changed'
                exit 0
            }
            if ([NaranhiNativeWindow]::HasCaption($readerHandle)) {
                $fullscreenExited = $true
                break
            }
            Start-Sleep -Milliseconds 50
        }
        if (-not $fullscreenExited) {
            Write-Result $false 'fullscreen-exit-not-confirmed'
            exit 0
        }
    }
    if (-not [NaranhiNativeWindow]::Matches($readerHandle, $expectedTitle, $browserProcessId)) {
        Write-Result $false 'window-changed'
        exit 0
    }
    if (-not [NaranhiNativeWindow]::Maximize($readerHandle)) {
        Write-Result $false 'native-command-timeout'
        exit 0
    }
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (-not [NaranhiNativeWindow]::Matches($readerHandle, $expectedTitle, $browserProcessId)) {
            Write-Result $false 'window-changed'
            exit 0
        }
        if ([NaranhiNativeWindow]::IsFramedMaximized($readerHandle)) {
            Write-Result $true 'maximized'
            exit 0
        }
        Start-Sleep -Milliseconds 50
    }
    Write-Result $false 'maximize-not-confirmed'
} catch {
    Write-Result $false 'native-helper-error'
}
