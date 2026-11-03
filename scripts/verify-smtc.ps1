# Lists Windows System Media Transport Controls sessions as JSON (title, artist, album, status, app id).
# Windows PowerShell 5.1:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-smtc.ps1 [-Title "x"]
# With -Title, exits 0 when a session with that title exists, else 1.
param([string]$Title = '')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  if (-not $task.Wait(5000)) { throw 'WinRT operation timed out' }
  $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$current = $mgr.GetCurrentSession()
$out = @()
foreach ($s in $mgr.GetSessions()) {
  $p = $null
  try { $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { }
  $info = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $out += [pscustomobject]@{
    appId      = $s.SourceAppUserModelId
    title      = if ($p) { $p.Title } else { $null }
    artist     = if ($p) { $p.Artist } else { $null }
    album      = if ($p) { $p.AlbumTitle } else { $null }
    status     = "$($info.PlaybackStatus)"
    positionMs = [math]::Round($tl.Position.TotalMilliseconds)
    endMs      = [math]::Round($tl.EndTime.TotalMilliseconds)
    current    = ($null -ne $current -and $current.SourceAppUserModelId -eq $s.SourceAppUserModelId)
  }
}

ConvertTo-Json -InputObject @($out) -Compress -Depth 3
if ($Title) {
  if (@($out | Where-Object { $_.title -eq $Title }).Count -gt 0) { exit 0 } else { exit 1 }
}
