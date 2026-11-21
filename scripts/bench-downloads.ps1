# Sprint 2: 6 canciones en serie frente a 3 a la vez, con las mismas opciones
# de yt-dlp que usa Enn (downloader.rs: speed_args + extracción a M4A).
# Objetivo: en paralelo al menos 2,5 veces más rápido si la conexión lo permite.
#
# uso: powershell -File scripts\bench-downloads.ps1 [-Parallel 3]
param([int]$Parallel = 3, [string]$FfmpegDir = "D:\enn-target\release")

$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "..\src-tauri\binaries"
$yt = Join-Path $bin "yt-dlp-x86_64-pc-windows-msvc.exe"
$ids = @("dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "JGwWNGJdvx8", "OPf0YbXqDm0", "fJ9rUzIMcZQ")
# yt-dlp busca «ffmpeg.exe»: el de src-tauri\binaries lleva el sufijo de
# plataforma; la compilación deja uno con el nombre normal junto a enn.exe
$common = @(
  "--no-playlist", "--no-warnings", "--quiet", "--encoding", "utf-8",
  "--concurrent-fragments", "4", "--http-chunk-size", "10M", "--throttled-rate", "100K",
  "--retries", "5", "--fragment-retries", "5", "--socket-timeout", "15",
  "--extract-audio", "--audio-format", "m4a", "--audio-quality", "0",
  "--ffmpeg-location", "`"$FfmpegDir`""
)

function Start-One($id, $dir) {
  $a = $common + @("-o", "`"$(Join-Path $dir '%(id)s.%(ext)s')`"", "https://music.youtube.com/watch?v=$id")
  return Start-Process -FilePath $yt -ArgumentList $a -NoNewWindow -PassThru
}

function Measure-Batch($label, $n) {
  $dir = Join-Path $env:TEMP ("enn-bench-dl-" + $label + "-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
  New-Item -ItemType Directory -Force $dir | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $queue = [System.Collections.Queue]::new($ids)
  $running = @()
  while ($queue.Count -gt 0 -or $running.Count -gt 0) {
    while ($running.Count -lt $n -and $queue.Count -gt 0) { $running += Start-One $queue.Dequeue() $dir }
    Start-Sleep -Milliseconds 100
    $running = @($running | Where-Object { -not $_.HasExited })
  }
  $sw.Stop()
  $files = @(Get-ChildItem $dir -Filter *.m4a)
  $mb = ($files | Measure-Object Length -Sum).Sum / 1MB
  Remove-Item -Recurse -Force $dir
  [pscustomobject]@{ modo = $label; a_la_vez = $n; segundos = [math]::Round($sw.Elapsed.TotalSeconds, 1); archivos = $files.Count; MB = [math]::Round($mb, 1) }
}

$serie = Measure-Batch "serie" 1
$par = Measure-Batch "paralelo" $Parallel
$serie, $par | Format-Table -AutoSize
"Aceleración: {0:N2}x" -f ($serie.segundos / $par.segundos)
