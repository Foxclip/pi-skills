param(
  [string]$OutDir = ".",
  [string[]]$Targets = @()
)
# Capture windows WITHOUT touching the foreground (PrintWindow).
# Targets: empty = every window with a main handle; else "<hwnd>" or "<hwnd>:<label>"
# or a process name. Saves <OutDir>/cap-<name>.png per window.
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Win32 -MemberDefinition '
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(int hWnd, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PrintWindow(int hWnd, IntPtr hdcBlt, int nFlags);
'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
$rows = @()
if ($Targets.Count -eq 0) {
  foreach ($p in $procs) { $rows += ,@($p.MainWindowHandle, $p.Name) }
} else {
  foreach ($t in $Targets) {
    if ($t -match "^([0-9]+):(.+)$") { $hwnd = $Matches[1]; $label = $Matches[2] }
    elseif ($t -match "^[0-9]+$") { $hwnd = $t; $label = "hwnd" + $t }
    else {
      $p = $procs | Where-Object { $_.Name -eq $t } | Select-Object -First 1
      if (-not $p) { Write-Output "no window for target '$t'"; continue }
      $hwnd = $p.MainWindowHandle; $label = $p.Name
    }
    $rows += ,@($hwnd, $label)
  }
}
foreach ($row in $rows) {
  $hwnd = [int]$row[0]
  $name = ($row[1] -replace "[^A-Za-z0-9._-]", "_")
  $out = Join-Path $OutDir ("cap-" + $name + ".png")
  try {
    $r = New-Object Win.Win32+RECT
    if (-not [Win.Win32]::GetWindowRect($hwnd, [ref]$r)) { Write-Output "$name : GetWindowRect failed"; continue }
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 100 -or $h -le 100) { Write-Output "$name : minimized/hidden (rect ${w}x${h}) - use cap-foreground.ps1"; continue }
    if ($w -gt 4000 -or $h -gt 4000) { Write-Output "$name : bad rect ${w}x${h}"; continue }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Win.Win32]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "$name : printwindow=$ok size=${w}x${h} -> $out"
  } catch {
    Write-Output "$name : ERROR $_"
  }
}
