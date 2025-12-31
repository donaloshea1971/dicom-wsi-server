# Script to restart the DICOM server after Docker fix

Write-Host "DICOM Server Restart Script" -ForegroundColor Cyan
Write-Host "===========================" -ForegroundColor Cyan
Write-Host ""

# Check if Docker is running
Write-Host "Checking Docker status..." -ForegroundColor Yellow
docker version > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is not running yet!" -ForegroundColor Red
    Write-Host "Please wait for Docker Desktop to fully start, then run this script again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit
}

Write-Host "Docker is running!" -ForegroundColor Green
Write-Host ""

# Navigate to project directory
$projectPath = "C:\Users\donal.oshea_deciphex\DICOM Server"
if (-not (Test-Path $projectPath)) {
    Write-Host "Project directory not found: $projectPath" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit
}

Set-Location $projectPath
Write-Host "Working directory: $(Get-Location)" -ForegroundColor Gray
Write-Host ""

# Stop any existing containers
Write-Host "Stopping any existing containers..." -ForegroundColor Yellow
docker compose down 2>$null

# Pull latest images
Write-Host ""
Write-Host "Pulling latest images..." -ForegroundColor Yellow
docker compose pull

# Build the converter service
Write-Host ""
Write-Host "Building converter service..." -ForegroundColor Yellow
docker compose build converter

# Start all services
Write-Host ""
Write-Host "Starting all services..." -ForegroundColor Yellow
docker compose up -d

# Wait a moment for services to start
Write-Host ""
Write-Host "Waiting for services to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Check service status
Write-Host ""
Write-Host "Checking service status..." -ForegroundColor Yellow
docker compose ps

# Test endpoints
Write-Host ""
Write-Host "Testing endpoints..." -ForegroundColor Yellow

# Test Orthanc
try {
    $orthancResponse = Invoke-WebRequest -Uri "http://localhost:8042/system" -UseBasicParsing -TimeoutSec 5
    Write-Host "✓ Orthanc is running at http://localhost:8042" -ForegroundColor Green
} catch {
    Write-Host "✗ Orthanc is not responding at http://localhost:8042" -ForegroundColor Red
}

# Test Viewer
try {
    $viewerResponse = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5
    Write-Host "✓ Viewer is running at http://localhost:3000" -ForegroundColor Green
} catch {
    Write-Host "✗ Viewer is not responding at http://localhost:3000" -ForegroundColor Red
}

# Test Converter API
try {
    $converterResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "✓ Converter API is running at http://localhost:3000/api" -ForegroundColor Green
} catch {
    Write-Host "✗ Converter API is not responding at http://localhost:3000/api" -ForegroundColor Red
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "DICOM Server restart completed!" -ForegroundColor Green
Write-Host ""
Write-Host "You can now:" -ForegroundColor Yellow
Write-Host "1. Open the viewer at: http://localhost:3000" -ForegroundColor White
Write-Host "2. Access Orthanc at: http://localhost:8042 (admin/orthanc)" -ForegroundColor White
Write-Host "3. Upload DICOM files for viewing" -ForegroundColor White
Write-Host ""
Write-Host "To check logs if needed:" -ForegroundColor Gray
Write-Host "  docker compose logs -f" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to exit"
