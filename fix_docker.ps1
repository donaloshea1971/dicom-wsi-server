# Docker Desktop WSL2 Corruption Fix Script
# This script will fix the corrupted Docker Desktop installation

Write-Host "Docker Desktop WSL2 Fix Script" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host ""

# Function to check if running as Administrator
function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Check if running as admin
if (-not (Test-Administrator)) {
    Write-Host "This script needs to run as Administrator." -ForegroundColor Yellow
    Write-Host "Right-click on PowerShell and select 'Run as Administrator', then run this script again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit
}

Write-Host "Step 1: Stopping Docker Desktop..." -ForegroundColor Green
# Try to stop Docker Desktop gracefully
$dockerProcess = Get-Process "Docker Desktop" -ErrorAction SilentlyContinue
if ($dockerProcess) {
    Write-Host "Found Docker Desktop running. Stopping it..." -ForegroundColor Yellow
    Stop-Process -Name "Docker Desktop" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
}

# Also stop Docker service if running
Stop-Service -Name "docker" -Force -ErrorAction SilentlyContinue
Stop-Service -Name "com.docker.service" -Force -ErrorAction SilentlyContinue

Write-Host "Step 2: Shutting down WSL2..." -ForegroundColor Green
wsl --shutdown
Start-Sleep -Seconds 3

Write-Host "Step 3: Backing up any existing data (if possible)..." -ForegroundColor Green
$backupPath = "$env:USERPROFILE\Desktop\docker_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null

# Try to backup settings
$dockerSettingsPath = "$env:APPDATA\Docker\settings.json"
if (Test-Path $dockerSettingsPath) {
    Copy-Item $dockerSettingsPath "$backupPath\settings.json" -ErrorAction SilentlyContinue
    Write-Host "Backed up Docker settings to $backupPath" -ForegroundColor Gray
}

Write-Host "Step 4: Removing corrupted Docker WSL distributions..." -ForegroundColor Green
# Get list of Docker-related WSL distributions
$wslDistros = wsl --list --quiet 2>$null | Where-Object { $_ -match 'docker' }

foreach ($distro in $wslDistros) {
    if ($distro.Trim() -ne '') {
        Write-Host "Unregistering: $distro" -ForegroundColor Yellow
        wsl --unregister $distro.Trim() 2>$null
    }
}

Write-Host "Step 5: Removing corrupted Docker data files..." -ForegroundColor Green
# Remove corrupted VHDX files
$dockerDataPaths = @(
    "$env:LOCALAPPDATA\Docker\wsl\disk",
    "$env:LOCALAPPDATA\Docker\wsl\distro"
)

foreach ($path in $dockerDataPaths) {
    if (Test-Path $path) {
        Write-Host "Removing: $path" -ForegroundColor Yellow
        Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Step 6: Clearing Docker cache and temporary files..." -ForegroundColor Green
$dockerCachePaths = @(
    "$env:LOCALAPPDATA\Docker\log",
    "$env:LOCALAPPDATA\Docker\pki",
    "$env:LOCALAPPDATA\Docker\vms"
)

foreach ($path in $dockerCachePaths) {
    if (Test-Path $path) {
        Write-Host "Clearing: $path" -ForegroundColor Yellow
        Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Step 7: Starting Docker Desktop..." -ForegroundColor Green
Write-Host "Docker Desktop will recreate all necessary files." -ForegroundColor Yellow

# Find Docker Desktop executable
$dockerDesktopPath = @(
    "${env:ProgramFiles}\Docker\Docker\Docker Desktop.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe",
    "$env:LOCALAPPDATA\Docker\Docker Desktop.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($dockerDesktopPath) {
    Write-Host "Starting Docker Desktop from: $dockerDesktopPath" -ForegroundColor Gray
    Start-Process $dockerDesktopPath
    
    Write-Host ""
    Write-Host "Waiting for Docker to initialize (this may take a few minutes)..." -ForegroundColor Yellow
    Write-Host "You should see the Docker Desktop window open." -ForegroundColor Yellow
    
    # Wait for Docker to start
    $timeout = 300  # 5 minutes
    $elapsed = 0
    $dockerReady = $false
    
    while ($elapsed -lt $timeout -and -not $dockerReady) {
        Start-Sleep -Seconds 10
        $elapsed += 10
        
        # Check if Docker is responding
        try {
            docker version 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                $dockerReady = $true
                Write-Host ""
                Write-Host "Docker is ready!" -ForegroundColor Green
            } else {
                Write-Host "." -NoNewline -ForegroundColor Yellow
            }
        } catch {
            Write-Host "." -NoNewline -ForegroundColor Yellow
        }
    }
    
    if (-not $dockerReady) {
        Write-Host ""
        Write-Host "Docker is taking longer than expected to start." -ForegroundColor Yellow
        Write-Host "Please wait for Docker Desktop to fully initialize before proceeding." -ForegroundColor Yellow
    }
    
} else {
    Write-Host "Could not find Docker Desktop executable." -ForegroundColor Red
    Write-Host "Please start Docker Desktop manually from the Start Menu." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Docker Desktop fix completed!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Wait for Docker Desktop to fully start (whale icon in system tray)" -ForegroundColor White
Write-Host "2. Open a new PowerShell window" -ForegroundColor White
Write-Host "3. Navigate to your project: cd `"C:\Users\donal.oshea_deciphex\DICOM Server`"" -ForegroundColor White
Write-Host "4. Rebuild your containers: docker compose up -d" -ForegroundColor White
Write-Host ""
Write-Host "If Docker Desktop asks to enable WSL2, click 'Enable'." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter to exit"
