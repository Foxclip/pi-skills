Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  [PSCustomObject]@{ Name = $_.Name; Hwnd = $_.MainWindowHandle; Title = $_.MainWindowTitle }
} | Sort-Object Name | Format-Table -AutoSize | Out-String -Width 200
