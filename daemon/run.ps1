# Build (if needed) and run mission_daemon on Windows. Extra arguments go to the daemon, e.g. .\daemon\run.ps1 --sim
# Needs CMake and Visual Studio Build Tools ("Desktop development with C++").
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  Write-Error "cmake not found. Install it from https://cmake.org/download/ and the Visual Studio Build Tools C++ workload."
}

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release | Out-Null
cmake --build build --parallel --config Release
$bin = Join-Path $PSScriptRoot "build\Release\mission_daemon.exe"
if (-not (Test-Path $bin)) { $bin = Join-Path $PSScriptRoot "build\mission_daemon.exe" }
& $bin @args
