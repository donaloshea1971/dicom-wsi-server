# DICOM Pathology WSI Server

A vendor-neutral DICOM WSI server with OpenSeadragon viewer for pathology workflows. Converts proprietary scanner formats (Philips iSyntax, Hamamatsu NDPI, Leica Aperio SVS) to DICOM and provides a modern web viewer.

## Quick Start

### Prerequisites
- Docker Desktop (Windows/Mac) or Docker + Docker Compose (Linux)
- 8GB+ RAM recommended
- 50GB+ disk space for WSI storage

### 1. Start the Stack

```bash
# Clone/navigate to project directory
cd "DICOM Server"

# Start all services
docker-compose up -d

# View logs
docker-compose logs -f
```

### 2. Access Services

| Service | URL | Credentials |
|---------|-----|-------------|
| **Orthanc Explorer** | http://localhost:8042 | admin / orthanc |
| **Converter API** | http://localhost:8000/docs | - |
| **Web Viewer** | http://localhost:3000 | - |

### 3. Upload a WSI File

```bash
# Via curl
curl -X POST "http://localhost:8000/upload" \
  -F "file=@/path/to/slide.ndpi"

# Or use the Swagger UI at http://localhost:8000/docs
```

### 4. Check Conversion Status

```bash
curl http://localhost:8000/jobs/<job_id>
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Web Viewer    │────▶│     NGINX       │
│  (OpenSeadragon)│     │  (port 3000)    │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
            ┌───────────┐ ┌───────────┐ ┌───────────┐
            │  Orthanc  │ │ Converter │ │   Redis   │
            │(port 8042)│ │(port 8000)│ │  (cache)  │
            └─────┬─────┘ └───────────┘ └───────────┘
                  │
            ┌─────┴─────┐
            │ PostgreSQL│
            │ (metadata)│
            └───────────┘
```

## Supported Formats

| Format | Extension | Scanner |
|--------|-----------|---------|
| Hamamatsu | .ndpi | NanoZoomer |
| Aperio | .svs | Leica Aperio |
| Philips | .isyntax | Philips IntelliSite |
| Mirax | .mrxs | 3DHistech |
| Leica | .scn | Leica SCN400 |
| Ventana | .bif | Roche Ventana |
| Generic TIFF | .tif, .tiff | Various |

## API Endpoints

### Converter Service (port 8000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Service status + Orthanc connectivity |
| POST | `/upload` | Upload WSI for conversion |
| GET | `/jobs` | List all conversion jobs |
| GET | `/jobs/{id}` | Get job status |
| DELETE | `/jobs/{id}` | Delete completed job |
| GET | `/studies` | List Orthanc studies |

### DICOMweb (via NGINX proxy)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dicom-web/studies` | QIDO-RS: Search studies |
| GET | `/dicom-web/studies/{uid}/series` | QIDO-RS: Search series |
| GET | `/dicom-web/studies/{uid}/series/{uid}/instances/{uid}/frames/{n}` | WADO-RS: Get frame |
| POST | `/dicom-web/studies` | STOW-RS: Store DICOM |

## Configuration

### Environment Variables

```bash
# Orthanc connection
ORTHANC_URL=http://orthanc:8042
ORTHANC_USERNAME=admin
ORTHANC_PASSWORD=orthanc

# Redis cache
REDIS_URL=redis://redis:6379

# Upload settings
WATCH_FOLDER=/uploads
MAX_UPLOAD_SIZE_GB=20

# Auth0 configuration (required for annotations & sharing)
AUTH0_DOMAIN=dev-jkm887wawwxknno6.us.auth0.com
AUTH0_AUDIENCE=https://pathviewpro.com/api
AUTH0_CLIENT_ID=your_client_id

# Database for user management
DATABASE_URL=postgresql://orthanc:password@postgres:5432/orthanc
```

### Orthanc Settings

Edit `config/orthanc.json`:

```json
{
  "RegisteredUsers": {
    "admin": "your_secure_password"
  },
  "DicomAet": "YOUR_AE_TITLE"
}
```

## Database Schema

PathView Pro uses PostgreSQL for user management, slide hierarchy, sharing, and annotations.

### Initialize Database

```bash
# Run the consolidated schema script
docker-compose exec postgres psql -U orthanc -d orthanc -f /path/to/scripts/init_schema.sql

# Or via local psql
psql -h localhost -U orthanc -d orthanc -f scripts/init_schema.sql
```

### Schema Overview

| Table | Description |
|-------|-------------|
| `users` | User accounts (synced from Auth0) |
| `patients` | Patient records (optional hierarchy) |
| `cases` | Case/accession records (optional hierarchy) |
| `blocks` | Tissue block records (optional hierarchy) |
| `slides` | WSI slides - primary entity linking to Orthanc |
| `slide_shares` | Direct slide sharing between users |
| `case_shares` | Share entire cases (all slides within) |
| `pending_shares` | Shares for users not yet registered |
| `annotations` | Drawing annotations on slides |
| `stain_types` | Reference table for common stains |

### Key Relationships

- `slides.orthanc_study_id` → Links to Orthanc Study UUID
- `slides.owner_id` → Slide ownership
- `slides.case_id` → Optional case grouping
- `slide_shares.slide_id` → Individual slide sharing
- `case_shares.case_id` → Case-level sharing (inherits to all slides)

## Development

### Local Development (without Docker)

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows

# Install dependencies
cd converter
pip install -r requirements.txt

# Run converter service
uvicorn main:app --reload --port 8000
```

### Rebuild Containers

```bash
docker-compose build --no-cache converter
docker-compose up -d
```

## Authentication & Annotations

PathView Pro uses Auth0 for user authentication. Authentication is required for:
- **Saving and loading annotations** (measurements, drawings)
- **Sharing slides** with other users
- **Managing cases and blocks** (hierarchical organization)

### Setup Authentication

1. **Configure Auth0** (see [AUTHENTICATION.md](AUTHENTICATION.md) for details)
   - Create Auth0 tenant and application
   - Set environment variables in `docker-compose.yml`
   - Configure callback URLs

2. **Verify Configuration**
   ```bash
   # Check environment variables
   docker-compose config | grep AUTH0
   
   # Test authentication flow
   python test_auth_flow.py
   
   # Or use the web-based test page
   # Open: http://localhost/test-auth.html
   ```

3. **Troubleshooting Auth Issues**
   - See [AUTHENTICATION.md](AUTHENTICATION.md) - Comprehensive troubleshooting guide
   - See [ANNOTATION_AUTH_FIX.md](ANNOTATION_AUTH_FIX.md) - Recent authentication fixes
   - Use the diagnostic tool: `/test-auth.html`

### Common Authentication Errors

**401 Unauthorized on annotation endpoints**:
```bash
# 1. Check if user is logged in (browser console)
# 2. Verify Auth0 configuration
docker-compose config | grep AUTH0

# 3. Check converter logs
docker logs dicom-converter -f | grep -i auth

# 4. Test with diagnostic page
# Open: http://localhost/test-auth.html
```

For detailed troubleshooting, see:
- **[AUTHENTICATION.md](AUTHENTICATION.md)** - Complete troubleshooting guide
- **[ANNOTATION_AUTH_FIX.md](ANNOTATION_AUTH_FIX.md)** - Recent authentication improvements

## Troubleshooting

### Orthanc won't start
```bash
# Check logs
docker-compose logs orthanc

# Verify PostgreSQL is healthy
docker-compose exec postgres pg_isready
```

### Conversion fails
```bash
# Check converter logs
docker-compose logs converter

# Verify file format is supported
# Check /uploads/failed for moved files
```

### Viewer can't load tiles
```bash
# Check CORS headers
curl -I http://localhost:3000/dicom-web/studies

# Verify Orthanc has the study
curl http://localhost:8042/studies -u admin:orthanc
```

### Authentication issues
```bash
# Run authentication test
python test_auth_flow.py

# Check backend logs
docker logs dicom-converter | grep -i "auth\|token"

# Use web-based diagnostic tool
# Open: http://localhost/test-auth.html
```

For comprehensive troubleshooting:
- **[AUTHENTICATION.md](AUTHENTICATION.md)** - Auth troubleshooting guide
- **[DEPLOYMENT.md](docs/DEPLOYMENT.md)** - Production deployment guide
- **[PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md)** - Architecture & design

## Deployment

For production deployment, see the comprehensive [Deployment Guide](docs/DEPLOYMENT.md).

Quick deployment:

```bash
# Linux/Mac
chmod +x scripts/deploy.sh
./scripts/deploy.sh setup

# Windows PowerShell
.\scripts\deploy.ps1 setup
```

## License

MIT License - See LICENSE file

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

