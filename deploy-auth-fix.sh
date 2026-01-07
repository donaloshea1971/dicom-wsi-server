#!/bin/bash
# Deploy Authentication Fix to Docker
# Rebuilds and restarts the affected containers

echo "================================="
echo "Deploying Authentication Fix"
echo "================================="
echo ""

# 1. Stop affected services
echo "1. Stopping affected services..."
docker-compose stop converter viewer

# 2. Rebuild converter (backend changes)
echo ""
echo "2. Rebuilding converter service (backend changes)..."
docker-compose build --no-cache converter

# 3. Rebuild viewer (frontend changes)
echo ""
echo "3. Rebuilding viewer service (frontend changes)..."
docker-compose build --no-cache viewer

# 4. Start services
echo ""
echo "4. Starting services..."
docker-compose up -d converter viewer

# 5. Wait for services to be ready
echo ""
echo "5. Waiting for services to be ready..."
sleep 10

# 6. Check status
echo ""
echo "6. Checking service status..."
docker-compose ps converter viewer

# 7. Show logs
echo ""
echo "7. Recent logs from converter:"
docker logs dicom-converter --tail 20

echo ""
echo "================================="
echo "Deployment Complete!"
echo "================================="
echo ""
echo "Next steps:"
echo "1. Open browser: http://localhost"
echo "2. Clear browser cache (Ctrl+Shift+Del)"
echo "3. Refresh page and log in"
echo "4. Test annotations - they should save without 401 errors"
echo ""
echo "Test pages:"
echo "- Auth diagnostic: http://localhost/test-auth.html"
echo ""
echo "Troubleshooting:"
echo "- View logs: docker logs dicom-converter -f"
echo "- Run tests: python test_auth_flow.py"
echo "- Read docs: AUTHENTICATION.md"
