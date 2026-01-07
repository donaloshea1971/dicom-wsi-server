# Deploy Authentication Fix to Docker
# Rebuilds and restarts the affected containers

Write-Host "=================================" -ForegroundColor Cyan
Write-Host "Deploying Authentication Fix" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host ""

# 1. Stop affected services
Write-Host "1. Stopping affected services..." -ForegroundColor Yellow
docker-compose stop converter viewer

# 2. Rebuild converter (backend changes)
Write-Host ""
Write-Host "2. Rebuilding converter service (backend changes)..." -ForegroundColor Yellow
docker-compose build --no-cache converter

# 3. Rebuild viewer (frontend changes)
Write-Host ""
Write-Host "3. Rebuilding viewer service (frontend changes)..." -ForegroundColor Yellow
docker-compose build --no-cache viewer

# 4. Start services
Write-Host ""
Write-Host "4. Starting services..." -ForegroundColor Yellow
docker-compose up -d converter viewer

# 5. Wait for services to be ready
Write-Host ""
Write-Host "5. Waiting for services to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# 6. Check status
Write-Host ""
Write-Host "6. Checking service status..." -ForegroundColor Yellow
docker-compose ps converter viewer

# 7. Show logs
Write-Host ""
Write-Host "7. Recent logs from converter:" -ForegroundColor Yellow
docker logs dicom-converter --tail 20

Write-Host ""
Write-Host "=================================" -ForegroundColor Green
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "=================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Open browser: http://localhost" -ForegroundColor White
Write-Host "2. Clear browser cache (Ctrl+Shift+Del)" -ForegroundColor White
Write-Host "3. Refresh page and log in" -ForegroundColor White
Write-Host "4. Test annotations - they should save without 401 errors" -ForegroundColor White
Write-Host ""
Write-Host "Test pages:" -ForegroundColor Cyan
Write-Host "- Auth diagnostic: http://localhost/test-auth.html" -ForegroundColor White
Write-Host ""
Write-Host "Troubleshooting:" -ForegroundColor Cyan
Write-Host "- View logs: docker logs dicom-converter -f" -ForegroundColor White
Write-Host "- Run tests: python test_auth_flow.py" -ForegroundColor White
Write-Host "- Read docs: AUTHENTICATION.md" -ForegroundColor White
