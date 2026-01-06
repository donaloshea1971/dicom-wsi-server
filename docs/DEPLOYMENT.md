# PathView Pro - Deployment Guide

This guide covers deploying PathView Pro to various environments.

## Quick Start

### Prerequisites

- **Docker** 20.10+ with Docker Compose V2
- **8GB+ RAM** recommended
- **50GB+ disk space** for WSI storage
- **Domain name** (for SSL)
- **Auth0 account** (for authentication)

### 1. Clone and Configure

```bash
# Clone repository
git clone https://github.com/your-org/dicom-wsi-server.git
cd dicom-wsi-server

# Copy and edit environment file
cp config/env.example .env
nano .env  # Edit with your values
```

### 2. Required Environment Variables

Edit `.env` with secure values:

```bash
# Database (generate strong passwords!)
POSTGRES_PASSWORD=your_secure_password_here

# Orthanc DICOM server
ORTHANC_PASSWORD=your_secure_password_here

# Auth0 (from your Auth0 dashboard)
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://your-domain.com/api
AUTH0_CLIENT_ID=your_client_id

# Public URL
PUBLIC_URL=https://your-domain.com
CORS_ALLOWED_ORIGINS=https://your-domain.com

# Optional: Email notifications
SMTP_HOST=smtp.your-provider.com
SMTP_USER=your_email
SMTP_PASSWORD=your_smtp_password
```

### 3. Deploy

```bash
# Linux/Mac
chmod +x scripts/deploy.sh
./scripts/deploy.sh setup

# Windows PowerShell
.\scripts\deploy.ps1 setup
```

---

## Deployment Commands

| Command | Description |
|---------|-------------|
| `setup` | Initial deployment with database initialization |
| `deploy` | Update to latest code and restart services |
| `update <service>` | Update specific service (converter, viewer, etc.) |
| `logs [service]` | View logs (all services or specific one) |
| `backup` | Backup PostgreSQL database |
| `restore <file>` | Restore from backup file |
| `ssl` | Setup Let's Encrypt SSL certificates |
| `status` | Show service health status |
| `stop` | Stop all services |
| `restart` | Restart all services |

---

## Architecture

```
Internet → Nginx (viewer) → Converter API → Orthanc DICOM Server
                ↓                 ↓
           Static Files      PostgreSQL ← Redis Cache
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| `viewer` | 80/443 | Nginx reverse proxy + static files |
| `converter` | (internal) | FastAPI backend for API + WSI conversion |
| `orthanc` | (internal) | DICOM server with DICOMweb |
| `postgres` | (internal) | PostgreSQL database |
| `redis` | (internal) | Tile caching |

**Security Note**: Only the `viewer` service exposes ports. All other services are internal.

---

## Cloud Deployment Options

### Option 1: VPS (DigitalOcean, Linode, Vultr)

**Recommended specs**: 4 vCPU, 8GB RAM, 100GB SSD

```bash
# SSH into your server
ssh root@your-server-ip

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Clone and deploy
git clone https://github.com/your-org/dicom-wsi-server.git
cd dicom-wsi-server
cp config/env.example .env
nano .env  # Configure
./scripts/deploy.sh setup
```

### Option 2: AWS EC2

1. Launch EC2 instance (t3.large or larger)
2. Security Group: Allow ports 80, 443
3. Install Docker and Docker Compose
4. Follow VPS deployment steps

### Option 3: Render.com

Use the provided `render.yaml` blueprint:

1. Fork repository to your GitHub
2. Create new Blueprint on Render
3. Connect your forked repo
4. Set environment variables in Render dashboard
5. Deploy

### Option 4: Railway

1. Fork repository
2. Create new project on Railway
3. Add services from `railway.toml`
4. Configure environment variables
5. Deploy

---

## SSL/TLS Configuration

### Let's Encrypt (Recommended)

```bash
# Set SSL variables in .env
SSL_DOMAIN=your-domain.com
SSL_EMAIL=admin@your-domain.com
ENABLE_TLS=true

# Run SSL setup
./scripts/deploy.sh ssl
```

### Custom Certificates

Mount your certificates to the viewer service:

```yaml
# docker-compose.override.yml
services:
  viewer:
    volumes:
      - ./certs/fullchain.pem:/etc/nginx/ssl/fullchain.pem:ro
      - ./certs/privkey.pem:/etc/nginx/ssl/privkey.pem:ro
```

---

## Database Management

### Initialize Schema

```bash
# Run init script
docker compose exec postgres psql -U orthanc -d orthanc -f /scripts/init_schema.sql

# Or manually
cat scripts/init_schema.sql | docker compose exec -T postgres psql -U orthanc -d orthanc
```

### Backup

```bash
# Automated backup
./scripts/deploy.sh backup

# Manual backup
docker compose exec postgres pg_dump -U orthanc orthanc > backup.sql
```

### Restore

```bash
# From backup file
./scripts/deploy.sh restore backups/20240101_120000.tar.gz

# Manual restore
cat backup.sql | docker compose exec -T postgres psql -U orthanc -d orthanc
```

---

## Monitoring & Troubleshooting

### Check Service Health

```bash
./scripts/deploy.sh status

# Or manually
docker compose ps
docker compose logs converter --tail=50
```

### Common Issues

#### 1. Services won't start
```bash
# Check logs
docker compose logs

# Ensure .env is configured
cat .env | grep -E "^[A-Z]"

# Check disk space
df -h
```

#### 2. Database connection errors
```bash
# Verify PostgreSQL is healthy
docker compose exec postgres pg_isready

# Check connection
docker compose exec postgres psql -U orthanc -d orthanc -c "SELECT 1"
```

#### 3. Upload failures
```bash
# Check converter logs
docker compose logs converter --tail=100

# Verify upload directory permissions
docker compose exec converter ls -la /uploads
```

#### 4. Tile loading errors (401/403)
```bash
# Check authentication flow
docker compose logs converter | grep -i auth

# Verify Auth0 configuration
echo $AUTH0_DOMAIN
echo $AUTH0_AUDIENCE
```

---

## Scaling

### Horizontal Scaling

For high-traffic deployments:

```yaml
# docker-compose.override.yml
services:
  converter:
    deploy:
      replicas: 3
```

### Resource Limits

Adjust in `docker-compose.yml`:

```yaml
services:
  orthanc:
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 1G
```

---

## Security Checklist

- [ ] Changed all default passwords in `.env`
- [ ] Enabled HTTPS with valid SSL certificate
- [ ] Configured CORS to specific origins only
- [ ] Set up firewall (only ports 80/443 open)
- [ ] Enabled Auth0 for authentication
- [ ] Regular backups configured
- [ ] Security headers enabled in Nginx

---

## Updates

### Pull Latest Code

```bash
./scripts/deploy.sh deploy
```

### Update Specific Service

```bash
./scripts/deploy.sh update converter
```

### Rollback

```bash
# Stop services
docker compose down

# Checkout previous version
git checkout v1.0.0

# Redeploy
./scripts/deploy.sh deploy
```
