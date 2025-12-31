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

## License

MIT License - See LICENSE file

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

