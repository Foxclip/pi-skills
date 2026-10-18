param(
  [Parameter(Mandatory = $true)][int]$Hwnd,
  [string]$Out = "",
  [int]$RestoreHwnd = 0
)
# Capture a window that PrintWindow cannot see (minimized, or GPU/DComp-rendered
# e.g. Windows Terminal): restore it, bring it to the foreground (ALT-key trick
# bypasses the foreground lock), CopyFromScreen, then restore the previous
# foreground window (-RestoreHwnd).
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Win32 -MemberDefinition '
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(int hWnd, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(int hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(int hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(int hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'
if (-not $Out) { $Out = "cap-hwnd" + $Hwnd + ".png" }
Write-Output ("before: iconic=" + [Win.Win32]::IsIconic($Hwnd))
[Win.Win32]::ShowWindow($Hwnd, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 600
[Win.Win32]::keybd_event(0x12, [byte]0, 0, [UIntPtr]::Zero) | Out-Null   # ALT down (foreground-lock bypass)
[Win.Win32]::SetForegroundWindow($Hwnd) | Out-Null
[Win.Win32]::keybd_event(0x12, [byte]0, 2, [UIntPtr]::Zero) | Out-Null   # ALT up
Start-Sleep -Milliseconds 800
$fg = [Win.Win32]::GetForegroundWindow()
if ($fg -ne $Hwnd) { Write-Output "WARNING: foreground=$fg want=$Hwnd - capture may be occluded" }
$r = New-Object Win.Win32+RECT
[Win.Win32]::GetWindowRect($Hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -gt 100 -and $h -gt 100) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "saved $Out ${w}x${h} at $($r.Left),$($r.Top)"
} else {
  Write-Output "bad rect ${w}x${h}, no capture"
}
if ($RestoreHwnd -ne 0) {
  Start-Sleep -Milliseconds 300
  [Win.Win32]::keybd_event(0x12, [byte]0, 0, [UIntPtr]::Zero) | Out-Null
  [Win.Win32]::SetForegroundWindow($RestoreHwnd) | Out-Null
  [Win.Win32]::keybd_event(0x12, [byte]0, 2, [UIntPtr]::Zero) | Out-Null
  Write-Output ("restored foreground: " + [Win.Win32]::GetForegroundWindow() + " (want " + $RestoreHwnd + ")")
}
