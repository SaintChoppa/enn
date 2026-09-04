# Desarrollar/ejecutar Enn evitando que OneDrive bloquee target\
$env:CARGO_TARGET_DIR = "D:\enn-target"
$env:Path = "$env:USERPROFILE\.cargo\bin;" + [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
npm run tauri dev
