<#
.SYNOPSIS
  Banco de arranque de Enn (Sprint 1, T1).

.DESCRIPTION
  Lanza enn.exe varias veces con --bench-startup, mide desde fuera el tiempo
  hasta que el proceso tiene ventana y lee el informe JSON que escribe la app
  (marcas de arranque y estadisticas de audio).

  Salida: tabla en consola y, en -OutDir, bench-<Label>.json (datos crudos)
  y bench-<Label>.md (mediana y percentil 90 de cada marca).

  Compatible con Windows PowerShell 5.1. El archivo es solo ASCII a proposito:
  PowerShell 5.1 lee los .ps1 sin BOM como ANSI y romperia las tildes.

.EXAMPLE
  .\scripts\bench-startup.ps1 -Exe D:\enn-target\release\enn.exe -Runs 10 -Label base -OutDir .snapshots\sprint-1
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 10,
  [string]$Label = (Get-Date -Format "yyyyMMdd-HHmmss"),
  [string]$OutDir = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
  throw "No existe el ejecutable: $Exe"
}
$Exe = (Resolve-Path -LiteralPath $Exe).Path
if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

$capMs = 40000   # tope por ejecucion
$pollMs = 10     # sondeo de la ventana

# percentil por rango mas cercano (p en 0..1); mediana = media de los dos centrales
function Get-Pct([double[]]$vals, [double]$p) {
  if (-not $vals -or $vals.Count -eq 0) { return $null }
  $s = @($vals | Sort-Object)
  $idx = [int][Math]::Ceiling($p * $s.Count) - 1
  if ($idx -lt 0) { $idx = 0 }
  if ($idx -ge $s.Count) { $idx = $s.Count - 1 }
  return [double]$s[$idx]
}
function Get-Median([double[]]$vals) {
  if (-not $vals -or $vals.Count -eq 0) { return $null }
  $s = @($vals | Sort-Object)
  $n = $s.Count
  if ($n % 2 -eq 1) { return [double]$s[($n - 1) / 2] }
  return ([double]$s[$n / 2 - 1] + [double]$s[$n / 2]) / 2
}
function Format-Ms($v) {
  if ($null -eq $v) { return "-" }
  return ([double]$v).ToString("0.0", [Globalization.CultureInfo]::InvariantCulture)
}

$results = @()
for ($i = 1; $i -le $Runs; $i++) {
  $tmp = Join-Path $env:TEMP ("enn-bench-{0}-{1}.json" -f $Label, $i)
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  # Start-Process une los argumentos con espacios: la ruta va entre comillas
  $p = Start-Process -FilePath $Exe -ArgumentList @("--bench-startup", "--bench-out", ('"' + $tmp + '"')) -PassThru

  $windowMs = $null
  while ($sw.ElapsedMilliseconds -lt $capMs) {
    $p.Refresh()
    if ($p.HasExited) { break }
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
      $windowMs = [double]$sw.Elapsed.TotalMilliseconds
      break
    }
    Start-Sleep -Milliseconds $pollMs
  }

  $left = [int]($capMs - $sw.ElapsedMilliseconds)
  if ($left -lt 0) { $left = 0 }
  $exited = $p.WaitForExit($left)
  $killed = $false
  if (-not $exited) {
    Write-Warning ("Ejecucion {0}: no termino en {1} s; se cierra" -f $i, ($capMs / 1000))
    try { $p.Kill() } catch {}
    $killed = $true
  }
  $totalMs = [double]$sw.Elapsed.TotalMilliseconds

  $report = $null
  if (Test-Path -LiteralPath $tmp) {
    try {
      $report = Get-Content -LiteralPath $tmp -Raw | ConvertFrom-Json
    } catch {
      Write-Warning ("Ejecucion {0}: JSON ilegible en {1}" -f $i, $tmp)
    }
  } else {
    Write-Warning ("Ejecucion {0}: la app no escribio {1}" -f $i, $tmp)
  }

  $timeout = $false
  if ($report -and $report.PSObject.Properties.Name -contains "timeout") { $timeout = [bool]$report.timeout }

  $results += [pscustomobject]@{
    run       = $i
    window_ms = $windowMs
    total_ms  = $totalMs
    killed    = $killed
    timeout   = $timeout
    report    = $report
  }
  Write-Host ("Ejecucion {0}/{1}: ventana {2} ms, total {3} ms{4}{5}" -f $i, $Runs, (Format-Ms $windowMs), (Format-Ms $totalMs), $(if ($timeout) { ", TIMEOUT" } else { "" }), $(if ($killed) { ", CERRADA" } else { "" }))

  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

# ---- resumen por marca (orden de primera aparicion)
$names = New-Object System.Collections.ArrayList
foreach ($r in $results) {
  if ($r.report -and $r.report.marks) {
    foreach ($m in $r.report.marks) {
      if (-not $names.Contains([string]$m.name)) { [void]$names.Add([string]$m.name) }
    }
  }
}

$rows = @()
$winVals = @($results | Where-Object { $null -ne $_.window_ms } | ForEach-Object { [double]$_.window_ms })
$rows += [pscustomobject]@{
  marca   = "ventana desde fuera"
  n       = $winVals.Count
  mediana = Get-Median $winVals
  p90     = Get-Pct $winVals 0.9
}
foreach ($n in $names) {
  $vals = @()
  foreach ($r in $results) {
    if ($r.report -and $r.report.marks) {
      foreach ($m in $r.report.marks) {
        if ([string]$m.name -eq $n) { $vals += [double]$m.ms }
      }
    }
  }
  $rows += [pscustomobject]@{
    marca   = $n
    n       = $vals.Count
    mediana = Get-Median $vals
    p90     = Get-Pct $vals 0.9
  }
}

$timeouts = @($results | Where-Object { $_.timeout }).Count
$killedN = @($results | Where-Object { $_.killed }).Count

Write-Host ""
Write-Host ("Banco de arranque '{0}': {1} ejecuciones, {2} con timeout, {3} cerradas a la fuerza" -f $Label, $Runs, $timeouts, $killedN)
$rows | Select-Object marca, n, @{ n = "mediana (ms)"; e = { Format-Ms $_.mediana } }, @{ n = "p90 (ms)"; e = { Format-Ms $_.p90 } } | Format-Table -AutoSize | Out-Host

# ---- archivos
$utf8 = New-Object System.Text.UTF8Encoding($false)

$raw = [pscustomobject]@{
  label    = $Label
  exe      = $Exe
  runs     = $Runs
  date     = (Get-Date).ToString("s")
  machine  = $env:COMPUTERNAME
  results  = $results
  summary  = $rows
}
$jsonPath = Join-Path $OutDir ("bench-{0}.json" -f $Label)
[IO.File]::WriteAllText($jsonPath, ($raw | ConvertTo-Json -Depth 10), $utf8)

$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine(("# Banco de arranque - {0}" -f $Label))
[void]$md.AppendLine("")
[void]$md.AppendLine(("- Ejecutable: ``{0}``" -f $Exe))
[void]$md.AppendLine(("- Fecha: {0}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm")))
[void]$md.AppendLine(("- Ejecuciones: {0} (timeout: {1}, cerradas a la fuerza: {2})" -f $Runs, $timeouts, $killedN))
[void]$md.AppendLine("")
[void]$md.AppendLine("| Marca | n | Mediana (ms) | p90 (ms) |")
[void]$md.AppendLine("|---|---:|---:|---:|")
foreach ($row in $rows) {
  [void]$md.AppendLine(("| {0} | {1} | {2} | {3} |" -f $row.marca, $row.n, (Format-Ms $row.mediana), (Format-Ms $row.p90)))
}
$mdPath = Join-Path $OutDir ("bench-{0}.md" -f $Label)
[IO.File]::WriteAllText($mdPath, $md.ToString(), $utf8)

Write-Host ("Escrito: {0}" -f $jsonPath)
Write-Host ("Escrito: {0}" -f $mdPath)
