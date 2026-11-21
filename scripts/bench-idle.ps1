<#
.SYNOPSIS
  Consumo de CPU de Enn en reposo (Sprint 1).

.DESCRIPTION
  Arranca enn.exe, espera a que asiente, mide el tiempo de CPU de enn.exe y de
  sus procesos de WebView2 durante -Seconds segundos y lo da como porcentaje
  de UN nucleo. Con -Hide esconde la ventana en la bandeja antes de medir.
  Cierra la instancia que lanzo al terminar.

  Solo ASCII: PowerShell 5.1 lee los .ps1 sin BOM como ANSI.

.EXAMPLE
  .\scripts\bench-idle.ps1 -Exe D:\enn-target\release\enn.exe -Seconds 30
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 30,
  [int]$Settle = 8,
  [switch]$Hide
)

$ErrorActionPreference = "Stop"
if (Get-Process enn -ErrorAction SilentlyContinue) { throw "Ya hay un Enn abierto: cierralo antes de medir." }

$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $Settle

if ($Hide) {
  Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'
  $p.Refresh()
  [void][W.U]::ShowWindow($p.MainWindowHandle, 0)
  Start-Sleep -Seconds 2
}

function Get-Tree([int]$rootId) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = @($rootId)
  $added = $true
  while ($added) {
    $added = $false
    foreach ($q in $all) {
      if (($ids -contains [int]$q.ParentProcessId) -and -not ($ids -contains [int]$q.ProcessId)) {
        $ids += [int]$q.ProcessId
        $added = $true
      }
    }
  }
  return $ids
}

function Get-CpuSeconds([int[]]$ids) {
  $sum = 0.0
  foreach ($i in $ids) {
    $pr = Get-Process -Id $i -ErrorAction SilentlyContinue
    if ($pr) { $sum += $pr.TotalProcessorTime.TotalSeconds }
  }
  return $sum
}

$ids = Get-Tree $p.Id
$c0 = Get-CpuSeconds $ids
$t0 = Get-Date
Start-Sleep -Seconds $Seconds
$c1 = Get-CpuSeconds $ids
$dt = ((Get-Date) - $t0).TotalSeconds

$mem = 0
foreach ($i in $ids) {
  $pr = Get-Process -Id $i -ErrorAction SilentlyContinue
  if ($pr) { $mem += $pr.WorkingSet64 }
}

$pct = [math]::Round(100.0 * ($c1 - $c0) / $dt, 2)
$memMb = [math]::Round($mem / 1MB, 1)
"procesos: $($ids.Count)  CPU: $pct % de un nucleo  memoria: $memMb MB  (oculta: $Hide)"

foreach ($i in $ids) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }
