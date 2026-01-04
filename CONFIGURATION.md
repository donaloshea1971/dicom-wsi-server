# PathView Pro - Configuration Guide

## 🌐 Domain Configuration

| Item | Value |
|------|-------|
| **Domain** | `pathviewpro.com` |
| **Registrar** | GoDaddy |
| **DNS Provider** | Cloudflare (for free HTTPS) |

### Cloudflare DNS Records

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | @ | 144.126.203.208 | ON ☁️ |

### GoDaddy Nameservers
Changed from GoDaddy default to Cloudflare nameservers.

---

## 🔐 Auth0 Configuration

| Item | Value |
|------|-------|
| **Tenant Domain** | `dev-jkm887wawwxknno6.us.auth0.com` |
| **Client ID** | `gT8pYvmdyFUhmPSVY5P5pAxiUwmTdvBr` |
| **Application Type** | Single Page Application |

### Auth0 Application URLs

| Setting | Value |
|---------|-------|
| **Allowed Callback URLs** | `https://pathviewpro.com/callback` |
| **Allowed Logout URLs** | `https://pathviewpro.com` |
| **Allowed Web Origins** | `https://pathviewpro.com` |

### Enabled Social Connections
- ✅ Google
- ✅ Microsoft

---

## 🖥️ Server Configuration

| Item | Value |
|------|-------|
| **Provider** | DigitalOcean |
| **IP Address** | `144.126.203.208` |
| **OS** | Ubuntu |
| **Project Path** | `/opt/dicom-wsi-server` |

### Docker Services

| Service | Internal Port | External Port | Description |
|---------|---------------|---------------|-------------|
| viewer | 80 | 80 | Nginx + Frontend |
| orthanc | 8042 | 8042 | DICOM Server |
| orthanc | 4242 | 4242 | C-STORE SCP |
| converter | 8000 | - | FastAPI Converter |
| postgres | 5432 | - | Database |
| redis | 6379 | - | Cache |
| cstore-proxy | 4243 | 4243 | C-STORE Proxy |

### Exposed Ports (Firewall)
- `80` - HTTP (redirects to HTTPS via Cloudflare)
- `443` - HTTPS (handled by Cloudflare)
- `4242` - DICOM C-STORE
- `4243` - C-STORE Proxy

---

## 📁 Key Files

### Frontend (viewer/)
| File | Purpose |
|------|---------|
| `landing.html` | Marketing landing page with SSO |
| `callback.html` | Auth0 callback handler |
| `index.html` | Main viewer (served as /viewer) |
| `upload.html` | Drag & drop upload page |
| `annotations.js` | Measurement/annotation tools |
| `color-correction.js` | ICC profile support |
| `sw.js` | Service worker for tile caching |

### Backend (converter/)
| File | Purpose |
|------|---------|
| `main.py` | FastAPI app - conversion, API proxy |
| `icc_parser.py` | ICC color profile parsing |

### Configuration
| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service orchestration |
| `orthanc/orthanc.json` | Orthanc server config |
| `postgres/postgresql-tuning.conf` | DB performance tuning |

---

## 🚀 Deployment Commands

### Full Rebuild & Deploy
```bash
ssh root@144.126.203.208
cd /opt/dicom-wsi-server
git pull origin main
docker compose build --no-cache
docker compose up -d
```

### Rebuild Single Service
```bash
docker compose build --no-cache viewer
docker compose up -d viewer
```

### View Logs
```bash
docker compose logs -f viewer
docker compose logs -f converter
docker compose logs -f orthanc
```

### Restart All Services
```bash
docker compose restart
```

---

## 🔗 URLs

| URL | Purpose |
|-----|---------|
| https://pathviewpro.com | Landing page |
| https://pathviewpro.com/viewer | Main viewer (requires login) |
| https://pathviewpro.com/upload | Upload page |
| https://pathviewpro.com/callback | Auth0 callback |

### API Endpoints
| Endpoint | Purpose |
|----------|---------|
| `/api/studies` | List all studies |
| `/api/studies/{id}` | Get study details |
| `/api/upload` | Upload WSI for conversion |
| `/api/instances` | Direct DICOM upload |
| `/api/annotations/{study_id}` | Get/save annotations |
| `/wsi/tiles/{id}/{level}/{x}/{y}` | WSI tile serving |

---

## 🛠️ Troubleshooting

### Auth0 "must run on secure origin"
- Ensure Cloudflare proxy is ON (orange cloud)
- Wait for DNS propagation (use dnschecker.org)
- Hard refresh browser: `Ctrl+Shift+R`

### Can't access site
```bash
# Check if containers are running
docker compose ps

# Check nginx logs
docker compose logs viewer

# Check if port 80 is listening
netstat -tlnp | grep :80
```

### Images not loading
```bash
# Check Orthanc logs
docker compose logs orthanc

# Check WSI plugin
curl -u admin:orthanc http://localhost:8042/wsi/
```

### Database issues
```bash
# Check postgres
docker compose logs postgres

# Access postgres
docker compose exec postgres psql -U orthanc -d orthanc
```

---

## 📊 Performance Tuning Applied

### Nginx
- Gzip compression enabled
- Tile caching (1GB, 7-day retention)
- Connection pooling to Orthanc
- Rate limiting (30 req/s)

### Orthanc
- 32 HTTP threads
- 1GB DICOM cache
- WSI plugin: 8 threads, 10K tile cache
- PostgreSQL prepared statements

### PostgreSQL
- 2GB shared buffers
- Optimized indexes for tile lookups

### Redis
- 200MB memory limit
- LRU eviction policy
- AOF persistence

---

## 📅 Maintenance

### Backup Database
```bash
docker compose exec postgres pg_dump -U orthanc orthanc > backup_$(date +%Y%m%d).sql
```

### Clear Tile Cache
```bash
docker compose exec viewer rm -rf /var/cache/nginx/tiles/*
```

### Update SSL Certificate
Cloudflare handles this automatically! ✅

---

*Last updated: January 2026*
