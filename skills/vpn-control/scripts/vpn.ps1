param([ValidateSet("on","off","status")][string]$Mode = "status")

# Toggle the AmneziaVPN desktop app's VPN via UI Automation.
# Requires the AmneziaVPN GUI (AmneziaVPN.exe) to be running.
# Exit codes: 0 = OK, 1 = state not reached in time, 2 = app window not found.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$BtnId = "AmneziaApplication.mainWindow.tabBarStackView.connectButton"
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $BtnId)
$btn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $btn) { Write-Output "ERROR: AmneziaVPN window not found (is the app running?)"; exit 2 }

function Get-ButtonName {
  return $btn.Current.Name
}

$name = Get-ButtonName
$connected = ($name -match "Connected")

if ($Mode -eq "status") { Write-Output $name; exit 0 }

$wantOn = ($Mode -eq "on")
if ($wantOn -eq $connected) {
  Write-Output "already $name"
  exit 0
}

$patternId = $btn.GetSupportedPatterns() | Where-Object { $_.ProgrammaticName -eq "InvokePatternIdentifiers.Pattern" }
if (-not $patternId) { Write-Output "ERROR: connect button does not support InvokePattern"; exit 1 }
$invoke = $btn.GetCurrentPattern($patternId)
$invoke.Invoke()

$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $isConnected = ((Get-ButtonName) -match "Connected")
  if ($isConnected -eq $wantOn) { Write-Output (Get-ButtonName); exit 0 }
}
Write-Output "ERROR: VPN did not reach '$Mode' state within 45s (last button name: '$(Get-ButtonName)')"
exit 1
