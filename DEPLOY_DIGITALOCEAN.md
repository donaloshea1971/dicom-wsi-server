# Deploy to Digital Ocean Ubuntu Server

## Quick Deploy (If Already Set Up)

SSH into your server and run:

```bash
cd /opt/dicom-server  # or wherever your repo is
git pull origin main
docker-compose build --no-cache converter viewer
docker-compose up -d converter viewer
docker logs dicom-converter --tail 20
```

Done! Clear your browser cache and test.

---

## Full Setup Instructions

### 1. Create Digital Ocean Droplet

**Recommended specs:**
- **Image**: Ubuntu 22.04 LTS
- **Size**: 4GB RAM / 2 vCPUs minimum (8GB recommended for WSI)
- **Storage**: 100GB+ (WSI files are large)
- **Region**: Choose closest to your users

### 2. Initial Server Setup

```bash
# SSH into your droplet
ssh root@your-droplet-ip

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose
apt install docker-compose-plugin -y

# Verify installation
docker --version
docker compose version

# Create app user (optional but recommended)
adduser dicom
usermod -aG docker dicom
```

### 3. Clone Repository

```bash
# As root or dicom user
cd /opt
git clone https://github.com/donaloshea1971/dicom-wsi-server.git dicom-server
cd dicom-server
```

### 4. Configure Environment

```bash
# Copy example env file
cp config/env.example .env

# Edit with your values
nano .env
```

**Required environment variables:**

```bash
# PostgreSQL
POSTGRES_DB=orthanc
POSTGRES_USER=orthanc
POSTGRES_PASSWORD=your_secure_password_here

# Orthanc
ORTHANC_USERNAME=admin
ORTHANC_PASSWORD=your_secure_orthanc_password

# Auth0 (REQUIRED for annotations)
AUTH0_DOMAIN=dev-jkm887wawwxknno6.us.auth0.com
AUTH0_AUDIENCE=https://pathviewpro.com/api

# Optional: Email notifications
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=your-email@domain.com
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=noreply@yourdomain.com

# App URL (for email links)
APP_URL=https://yourdomain.com
```

### 5. Configure Auth0 (Important!)

In your Auth0 dashboard, update:

**Application Settings:**
- Allowed Callback URLs: `https://yourdomain.com/callback`
- Allowed Logout URLs: `https://yourdomain.com`
- Allowed Web Origins: `https://yourdomain.com`

**API Settings:**
- Identifier: `https://pathviewpro.com/api` (or your custom audience)

### 6. SSL Certificate Setup

**Option A: Let's Encrypt (Recommended)**

```bash
# Install certbot
apt install certbot -y

# Get certificate (stop nginx first if running)
certbot certonly --standalone -d yourdomain.com

# Certificates will be at:
# /etc/letsencrypt/live/yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/yourdomain.com/privkey.pem
```

**Option B: Using Docker Compose Certbot (Auto-renewal)**

Uncomment the certbot service in `docker-compose.yml` and configure.

### 7. Update NGINX for Production

Edit `viewer/Dockerfile` or create a production nginx config:

```bash
nano config/nginx-production.conf
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;
    
    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # ... rest of nginx config from config/nginx.conf
}
```

### 8. Start Services

```bash
cd /opt/dicom-server

# Build all images
docker-compose build

# Start in detached mode
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### 9. Initialize Database

```bash
# Wait for postgres to be ready
sleep 10

# Run schema initialization
docker-compose exec postgres psql -U orthanc -d orthanc -f /docker-entrypoint-initdb.d/init_schema.sql

# Or manually:
docker-compose exec -T postgres psql -U orthanc -d orthanc < scripts/init_schema.sql
```

### 10. Verify Deployment

```bash
# Check all services are running
docker-compose ps

# Test health endpoints
curl http://localhost/health
curl http://localhost/api/health

# Check converter logs
docker logs dicom-converter --tail 50

# Test authentication (from browser)
# Open: https://yourdomain.com/test-auth.html
```

---

## Update Deployment

When you make changes and push to git:

```bash
# SSH into server
ssh root@your-droplet-ip

# Pull latest changes
cd /opt/dicom-server
git pull origin main

# Rebuild and restart affected services
docker-compose build --no-cache converter viewer
docker-compose up -d converter viewer

# Verify
docker-compose ps
docker logs dicom-converter --tail 20
```

### Quick Update Script

Create `/opt/dicom-server/update.sh`:

```bash
#!/bin/bash
echo "Updating DICOM Server..."
cd /opt/dicom-server
git pull origin main
docker-compose build --no-cache converter viewer
docker-compose up -d converter viewer
echo "Update complete!"
docker-compose ps
```

```bash
chmod +x update.sh
./update.sh
```

---

## Firewall Configuration

```bash
# Allow SSH
ufw allow 22

# Allow HTTP/HTTPS
ufw allow 80
ufw allow 443

# Enable firewall
ufw enable

# Check status
ufw status
```

---

## Monitoring & Maintenance

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker logs dicom-converter -f
docker logs dicom-orthanc -f
docker logs dicom-viewer -f
```

### Restart Services

```bash
# Restart all
docker-compose restart

# Restart specific service
docker-compose restart converter
```

### Database Backup

```bash
# Backup PostgreSQL
docker-compose exec postgres pg_dump -U orthanc orthanc > backup_$(date +%Y%m%d).sql

# Restore
docker-compose exec -T postgres psql -U orthanc orthanc < backup_20240107.sql
```

### Disk Space

```bash
# Check disk usage
df -h

# Docker disk usage
docker system df

# Clean unused images/containers
docker system prune -a
```

---

## Troubleshooting

### 401 Errors on Annotations

1. Check Auth0 configuration:
   ```bash
   docker-compose exec converter env | grep AUTH0
   ```

2. Test authentication:
   - Open `https://yourdomain.com/test-auth.html`
   - Click "Get Access Token"
   - Click "Test Annotation API"

3. Check logs:
   ```bash
   docker logs dicom-converter | grep -i auth
   ```

### Services Won't Start

```bash
# Check logs for errors
docker-compose logs

# Check specific service
docker-compose logs converter

# Restart with fresh build
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Database Connection Issues

```bash
# Check postgres is running
docker-compose ps postgres

# Check connection
docker-compose exec postgres pg_isready

# View postgres logs
docker logs dicom-postgres
```

### SSL Certificate Issues

```bash
# Renew Let's Encrypt
certbot renew

# Check certificate
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com
```

---

## Production Checklist

- [ ] Strong passwords in `.env`
- [ ] SSL certificate installed
- [ ] Auth0 callback URLs configured
- [ ] Firewall enabled (only 22, 80, 443)
- [ ] Database backups scheduled
- [ ] Monitoring set up (optional: Datadog, New Relic)
- [ ] Log rotation configured
- [ ] DNS pointing to droplet IP

---

## Support

- **Auth issues**: See `AUTHENTICATION.md`
- **General docs**: See `README.md`
- **API docs**: `https://yourdomain.com/api/docs`
