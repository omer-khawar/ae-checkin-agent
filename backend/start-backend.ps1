# One-click local setup + run for Windows.
# Finds Python 3.10+ (installs Python 3.12 with winget if missing), creates .venv,
# installs requirements, then starts the API at http://localhost:8000/docs.
# Safe to run again: it reuses the existing .venv.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-Python {
    $candidates = New-Object System.Collections.Generic.List[object]
    if (Get-Command py -ErrorAction SilentlyContinue) { $candidates.Add(@{ Exe = "py"; Extra = @("-3") }) }
    if (Get-Command python -ErrorAction SilentlyContinue) { $candidates.Add(@{ Exe = "python"; Extra = @() }) }
    $found = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", "$env:ProgramFiles\Python3*\python.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending
    foreach ($p in $found) { $candidates.Add(@{ Exe = $p.FullName; Extra = @() }) }

    foreach ($c in $candidates) {
        try {
            $extra = $c.Extra
            # The Microsoft Store "python" stub exits non-zero here, so it is skipped.
            $v = & $c.Exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
            if ($LASTEXITCODE -eq 0 -and "$v" -match '^3\.(\d+)$' -and [int]$Matches[1] -ge 10) { return $c }
        } catch { }
    }
    return $null
}

Write-Host "== AE Capture Desk backend setup ==" -ForegroundColor Cyan
$py = Find-Python

if (-not $py) {
    Write-Host "Python 3.10+ not found. Installing Python 3.12 with winget..." -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "winget isn't available. Install Python 3.12 from https://www.python.org/downloads/" -ForegroundColor Red
        Write-Host "(tick 'Add python.exe to PATH' on the first screen), then run start-backend.bat again." -ForegroundColor Red
        exit 1
    }
    winget install -e --id Python.Python.3.12 --scope user
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
    $py = Find-Python
    if (-not $py) {
        Write-Host "Python was installed but this window can't see it yet. Close it and run start-backend.bat again." -ForegroundColor Yellow
        exit 1
    }
}

$extra = $py.Extra
$ver = & $py.Exe @extra -c "import sys; print(sys.version.split()[0])"
Write-Host "Using Python $ver ($($py.Exe))"

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creating virtual environment (.venv)..."
    & $py.Exe @extra -m venv .venv
    if ($LASTEXITCODE -ne 0) { Write-Host "Could not create .venv" -ForegroundColor Red; exit 1 }
}
$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "Installing requirements (first run takes a minute)..."
& $venvPy -m pip install --disable-pip-version-check -q -r requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Host "pip install failed (see errors above)" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Starting the API. Docs: http://localhost:8000/docs   (press Ctrl+C to stop)" -ForegroundColor Green
# Open the docs in the browser a few seconds after the server starts.
Start-Process -WindowStyle Hidden cmd -ArgumentList '/c timeout /t 6 >nul & start "" http://localhost:8000/docs'
& $venvPy -m uvicorn app.main:app --reload
