# PowerShell script to run C-STORE tests on Windows

Write-Host "C-STORE Validation Test Runner" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host ""

# Check if virtual environment exists
if (-not (Test-Path "venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    python -m venv venv
}

# Activate virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Yellow
& .\venv\Scripts\Activate.ps1

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt

# Run the test suite
Write-Host "`nRunning C-STORE validation tests..." -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
python test_c_store.py

# Deactivate virtual environment
deactivate

Write-Host "`nTest execution complete!" -ForegroundColor Cyan
Write-Host "Check the output above for test results." -ForegroundColor Cyan
Write-Host ""
Write-Host "To send individual files, use:" -ForegroundColor Yellow
Write-Host "  python simple_c_store_client.py <dicom_file>" -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to exit"
