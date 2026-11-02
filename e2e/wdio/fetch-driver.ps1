# Downloads the Edge WebDriver matching the installed WebView2 runtime into e2e/.work/driver.
$ErrorActionPreference = 'Stop'

$clientKey = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$version = $null
foreach ($hive in 'HKLM:', 'HKCU:') {
  $item = Get-ItemProperty -Path "$hive\$clientKey" -Name pv -ErrorAction SilentlyContinue
  if ($item -and $item.pv -and $item.pv -ne '0.0.0.0') { $version = $item.pv; break }
}
if (-not $version) { throw 'WebView2 runtime not found' }

$target = Join-Path $PSScriptRoot '..\.work\driver'
$exe = Join-Path $target 'msedgedriver.exe'
if ((Test-Path $exe) -and ((& $exe --version) -match [regex]::Escape($version))) {
  Write-Output "msedgedriver $version already present"
  exit 0
}

New-Item -ItemType Directory -Force $target | Out-Null
$zip = Join-Path $target 'edgedriver_win64.zip'
Invoke-WebRequest -Uri "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $target -Force
Remove-Item $zip
& $exe --version
