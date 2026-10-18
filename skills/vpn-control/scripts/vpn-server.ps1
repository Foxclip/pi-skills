param(
  [Parameter(Mandatory = $true)][string]$Server,   # country name as shown in the app, e.g. "Poland"
  [switch]$Reconnect                               # stay connected after switching
)

# Switch the AmneziaVPN server, fully windowless (UIA only, no foregrounding, no mouse):
#   1. make sure the connect bar is visible (resets the view via homeTabButton if stuck)
#   2. disconnect if connected (Amnezia refuses server changes while connected)
#   3. open the server picker (invoke the server button in the connect bar)
#   4. select the target country via SelectionItemPattern
#   5. verify the bar now shows the target server
#   6. reconnect if requested
#
# Exit codes: 0 = ok, 1 = step failed, 2 = AmneziaVPN window not found (app not running).

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "AmneziaVPN")
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
if (-not $win) { Write-Output "ERROR: AmneziaVPN window not found (is the app running?)"; exit 2 }

function Find-ById([string]$id) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}
function Invoke-El($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Reset-View {
  # The app UI sometimes gets stuck (picker left open, or an unrelated panel). Invoking
  # the home tab button always resets the view to the connect bar.
  $homeBtn = Find-ById "AmneziaApplication.mainWindow.tabBar.homeTabButton"
  if ($homeBtn) { Invoke-El $homeBtn; Start-Sleep -Seconds 2 }
}
function Get-ConnectBtn {
  $b = Find-ById "AmneziaApplication.mainWindow.tabBarStackView.connectButton"
  if (-not $b) { Reset-View; $b = Find-ById "AmneziaApplication.mainWindow.tabBarStackView.connectButton" }
  return $b
}
function Get-ServerBtn {
  # The server button is the BasicButtonType child of the connect bar stack that carries
  # a generic QML id (no explicit splitTunneling/protocol id).
  $stack = Find-ById "AmneziaApplication.mainWindow.tabBarStackView"
  if (-not $stack) { return $null }
  foreach ($c in $stack.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($c.Current.ClassName -like 'BasicButtonType*' -and $c.Current.AutomationId -notlike '*splitTunneling*' -and $c.Current.AutomationId -notlike '*protocol*') { return $c }
    } catch {}
  }
  return $null
}
function Get-ServerRadio([string]$name) {
  # Radio in the open picker, matched by class prefix + exact name (avoids the bar's
  # server button, which is also named after the current server).
  foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($c.Current.ClassName -like 'VerticalRadioButton*' -and $c.Current.Name -eq $name) { return $c }
    } catch {}
  }
  return $null
}

# --- step 1: connect bar must be visible
$btn = Get-ConnectBtn
if (-not $btn) { Write-Output "ERROR: connect bar not visible and home-tab reset failed"; exit 1 }

# --- step 2: disconnect if connected (wait until fully down before touching the picker;
# mid-transition is what makes the picker stick open)
if (($btn.Current.Name) -match '^Connected$') {
  Write-Output "disconnected (was: $(($btn.Current.Name)))"
  Invoke-El $btn
  $deadline = (Get-Date).AddSeconds(90)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $b2 = Get-ConnectBtn
    if ($b2 -and ($b2.Current.Name -match '^Connect$')) { $btn = $b2; $ok = $true; break }
  }
  if (-not $ok) { Write-Output "ERROR: did not fully disconnect within 90s (last: '$($btn.Current.Name)')"; exit 1 }
  Write-Output "now: $(($btn.Current.Name))"
}

# --- step 3: open the server picker.
# The server button and the protocol button (e.g. 'VLESS') share the BasicButtonType class,
# so verify success by the target radio appearing, and try the next candidate if not.
$stack = Find-ById "AmneziaApplication.mainWindow.tabBarStackView"
$cands = @()
if ($stack) {
  foreach ($c in $stack.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      # skip splitTunnelingButton / protocolButton — same class, different ids, and
      # invoking them has side effects (toggles the setting)
      if ($c.Current.ClassName -like 'BasicButtonType*' -and $c.Current.AutomationId -notlike '*splitTunneling*' -and $c.Current.AutomationId -notlike '*protocol*') { $cands += $c }
    } catch {}
  }
}
$targetRadio = $null
foreach ($cand in $cands) {
  Invoke-El $cand
  Start-Sleep -Seconds 2
  $targetRadio = Get-ServerRadio $Server
  if ($targetRadio) { Write-Output "picker opened via button '$($cand.Current.Name)'"; break }
}
if (-not $targetRadio) { Write-Output "ERROR: server '$Server' not found in picker (check the country name)"; exit 1 }

# --- step 4: select target server
try {
  $targetRadio.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Write-Output "selected '$Server' via SelectionItemPattern"
} catch {
  Invoke-El $targetRadio
  Write-Output "selected '$Server' via InvokePattern"
}
Start-Sleep -Seconds 2

# --- step 5: verify the picker closed and the bar shows the target server
$btn = Get-ConnectBtn
if (-not $btn) { Write-Output "ERROR: connect bar not visible after selection (picker stuck, home reset failed)"; exit 1 }
$srv = Get-ServerBtn
if (-not $srv -or ($srv.Current.Name -ne $Server)) {
  Write-Output "ERROR: selection not committed (bar shows '$($srv.Current.Name)', want '$Server')"; exit 1
}
Write-Output "bar shows '$($srv.Current.Name)'"

# --- step 6: reconnect if requested
if ($Reconnect) {
  Invoke-El $btn
  $deadline = (Get-Date).AddSeconds(90)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $b2 = Get-ConnectBtn
    if ($b2 -and ($b2.Current.Name -match '^Connected$')) { $btn = $b2; $up = $true; break }
  }
  if (-not $up) { Write-Output "ERROR: did not reconnect within 90s (last: '$($btn.Current.Name)')"; exit 1 }
  Write-Output "reconnected to $Server"
  exit 0
}
Write-Output "DONE (disconnected, server=$Server)"
exit 0
