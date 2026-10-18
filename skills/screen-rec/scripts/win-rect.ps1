param(
  [long]$Hwnd = 0,
  [string]$Title = ''
)
# Preflight window-state check for rec-window.sh (gfxcapture).
# Prints ONE machine-parseable line:
#   OK <hwnd> <W>x<H>      window exists, normal size
#   MINIMIZED <hwnd> WxH   rect <=100x100 - the minimized/hidden tell.
#                          gfxcapture HANGS with zero frames on such windows
#                          (WGC never delivers a frame for an un-composited
#                          surface) - rec-window.sh refuses to start.
#   NOTFOUND               no MAIN window matches (title mode only; a
#                          non-main window match is possible, so callers
#                          warn-and-continue rather than refuse)
#   BADHWND               GetWindowRect failed (hwnd mode)
# ASCII-only (PS 5.1 + no BOM). File-based: inline -Command with $_ is
# mangled by MSYS bash, which is why this is a script.
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Win32 -MemberDefinition '
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(int hWnd, out RECT r);
'
if ($Hwnd -eq 0 -and $Title -eq '') { Write-Output 'NOTFOUND'; exit 0 }
$h = [long]$Hwnd
if ($h -eq 0) {
  # case-sensitive regex, matching gfxcapture's PCRE semantics (?i) to opt in
  $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and [regex]::IsMatch($_.MainWindowTitle, $Title) } | Select-Object -First 1
  if (-not $p) { Write-Output 'NOTFOUND'; exit 0 }
  $h = [long]$p.MainWindowHandle
}
$r = New-Object Win.Win32+RECT
if (-not [Win.Win32]::GetWindowRect([int]$h, [ref]$r)) { Write-Output 'BADHWND'; exit 0 }
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
# same <=100 tell as cap-windows.ps1 (minimized rect here: 160x28 @ -32000)
if ($w -le 100 -or $ht -le 100) { Write-Output "MINIMIZED $h ${w}x${ht}" }
else { Write-Output "OK $h ${w}x${ht}" }
