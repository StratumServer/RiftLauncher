[CmdletBinding()]
param(
  [string]$AppPath = "",
  [int]$WarmupSeconds = 15,
  [int]$SampleSeconds = 10,
  [int]$StartupTimeoutSeconds = 45,
  [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Join-Path -Path $PSScriptRoot -ChildPath "..\dist\win-unpacked\VS Launcher.exe"
}

function Get-ProcessTreeIds([int]$RootProcessId) {
  $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $childrenByParent = @{}
  foreach ($processInfo in $processes) {
    $parentId = [int]$processInfo.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) { $childrenByParent[$parentId] = @() }
    $childrenByParent[$parentId] += [int]$processInfo.ProcessId
  }

  $result = [System.Collections.Generic.HashSet[int]]::new()
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $result.Add($RootProcessId) | Out-Null
  $pending.Enqueue($RootProcessId)

  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    if (-not $childrenByParent.ContainsKey($parentId)) { continue }
    foreach ($childId in $childrenByParent[$parentId]) {
      if ($result.Add($childId)) { $pending.Enqueue($childId) }
    }
  }

  return @($result)
}

function Get-RuntimeSnapshot([int]$RootProcessId) {
  $ids = @(Get-ProcessTreeIds $RootProcessId)
  $rows = @()
  foreach ($processId in $ids) {
    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $rows += [PSCustomObject]@{
        Id = $process.Id
        Name = $process.ProcessName
        WorkingSetBytes = [int64]$process.WorkingSet64
        PrivateBytes = [int64]$process.PrivateMemorySize64
        CpuSeconds = [double]$process.TotalProcessorTime.TotalSeconds
      }
    } catch {
      # Processes can exit between the tree and process snapshots.
    }
  }

  return $rows
}

function Stop-ProcessTree([int]$RootProcessId) {
  $ids = @(Get-ProcessTreeIds $RootProcessId)
  foreach ($processId in ($ids | Sort-Object -Descending)) {
    try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch { }
  }
}

$resolvedAppPath = [System.IO.Path]::GetFullPath($AppPath)
if (-not (Test-Path -LiteralPath $resolvedAppPath -PathType Leaf)) {
  throw "Packaged application not found: $resolvedAppPath"
}

$oldUpdateValue = $env:UPDATE
$rootProcess = $null
$startedAt = Get-Date

try {
  $env:UPDATE = "false"
  $rootProcess = Start-Process -FilePath $resolvedAppPath -PassThru
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)

  do {
    Start-Sleep -Milliseconds 250
    $rootProcess.Refresh()
    if ($rootProcess.HasExited) { throw "Packaged application exited before showing its main window." }
  } while ($rootProcess.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)

  if ($rootProcess.MainWindowHandle -eq 0) { throw "Timed out waiting for the main window." }
  $startupMilliseconds = [math]::Round(((Get-Date) - $startedAt).TotalMilliseconds, 0)

  Start-Sleep -Seconds $WarmupSeconds
  $sampleStart = Get-Date
  $before = @(Get-RuntimeSnapshot $rootProcess.Id)
  Start-Sleep -Seconds $SampleSeconds
  $sampleEnd = Get-Date
  $after = @(Get-RuntimeSnapshot $rootProcess.Id)

  $workingSetBytes = ($after | Measure-Object -Property WorkingSetBytes -Sum).Sum
  $privateBytes = ($after | Measure-Object -Property PrivateBytes -Sum).Sum
  $beforeCpu = ($before | Measure-Object -Property CpuSeconds -Sum).Sum
  $afterCpu = ($after | Measure-Object -Property CpuSeconds -Sum).Sum
  $elapsedSeconds = [math]::Max(($sampleEnd - $sampleStart).TotalSeconds, 0.001)
  $cpuSeconds = [math]::Round(([double]$afterCpu - [double]$beforeCpu), 3)
  $cpuPercent = [math]::Round(($cpuSeconds / ($elapsedSeconds * [Environment]::ProcessorCount)) * 100, 2)

  $result = [PSCustomObject]@{
    MeasuredAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    Application = [System.IO.Path]::GetFileName($resolvedAppPath)
    StartupMilliseconds = $startupMilliseconds
    WarmupSeconds = $WarmupSeconds
    SampleSeconds = [math]::Round($elapsedSeconds, 2)
    ProcessCount = $after.Count
    WorkingSetMiB = [math]::Round(([double]$workingSetBytes / 1MB), 1)
    PrivateMiB = [math]::Round(([double]$privateBytes / 1MB), 1)
    CpuSeconds = $cpuSeconds
    CpuPercentOfMachine = $cpuPercent
  }

  $result | Format-List
  if ($OutputPath) {
    $result | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  }
} finally {
  if ($rootProcess) { Stop-ProcessTree $rootProcess.Id }
  if ($null -eq $oldUpdateValue) { Remove-Item Env:UPDATE -ErrorAction SilentlyContinue } else { $env:UPDATE = $oldUpdateValue }
}
