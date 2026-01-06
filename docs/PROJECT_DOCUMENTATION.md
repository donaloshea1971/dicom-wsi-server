# PathView Pro - Comprehensive Project Documentation

**Version:** 1.1.0 | **Last Updated:** January 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Slide Hierarchy Model](#slide-hierarchy-model)
5. [Authentication & Authorization](#authentication--authorization)
6. [API Reference](#api-reference)
7. [Deployment](#deployment)
8. [Configuration](#configuration)
9. [Database Schema](#database-schema)
10. [Email Notifications](#email-notifications)
11. [SpaceMouse Integration](#spacemouse-integration)
12. [Troubleshooting](#troubleshooting)

---

## Overview

PathView Pro is a professional-grade, web-based digital pathology viewer designed for viewing, managing, and sharing Whole Slide Images (WSI). The platform converts proprietary scanner formats to standard DICOM and provides a high-performance viewing experience with enterprise features including user authentication, slide ownership, sharing, and email notifications.

### Key Capabilities

- **Multi-format WSI support**: SVS, NDPI, iSyntax, MRXS, TIFF, BIF, SCN
- **DICOM compliance**: Full DICOMweb API support
- **Enterprise authentication**: Auth0 OAuth2/OIDC integration
- **Slide management**: Patient → Case → Block → Slide hierarchy
- **Collaboration**: Share slides with colleagues via email
- **High-performance viewer**: OpenSeadragon with tile caching
- **SpaceMouse support**: 6DOF navigation via WebHID API

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NGINX (Reverse Proxy)                          │
│                          pathviewpro.com (HTTPS/443)                        │
└─────────────────┬───────────────────────────────────┬───────────────────────┘
                  │                                   │
                  ▼                                   ▼
┌─────────────────────────────────┐   ┌───────────────────────────────────────┐
│       Viewer (Static Files)     │   │      Converter API (FastAPI)          │
│  ┌────────────────────────────┐ │   │  ┌─────────────────────────────────┐  │
│  │ • OpenSeadragon Viewer     │ │   │  │ • WSI → DICOM conversion        │  │
│  │ • Auth0 SPA SDK            │ │   │  │ • JWT authentication            │  │
│  │ • SpaceMouse WebHID        │ │   │  │ • Study/Slide management        │  │
│  │ • Service Worker (cache)   │ │   │  │ • Sharing & notifications       │  │
│  │ • Annotation tools         │ │   │  │ • Chunked file uploads          │  │
│  └────────────────────────────┘ │   │  └─────────────────────────────────┘  │
└─────────────────────────────────┘   └────────────────┬──────────────────────┘
                                                       │
                       ┌───────────────────────────────┼───────────────────────┐
                       │                               │                       │
                       ▼                               ▼                       ▼
         ┌─────────────────────┐       ┌─────────────────────┐   ┌─────────────────┐
         │   Orthanc (DICOM)   │       │     PostgreSQL      │   │      Redis      │
         │  ┌───────────────┐  │       │  ┌───────────────┐  │   │  ┌───────────┐  │
         │  │ DICOM storage │  │       │  │ Users         │  │   │  │ Job queue │  │
         │  │ DICOMweb API  │  │       │  │ Slides        │  │   │  │ Sessions  │  │
         │  │ WSI plugin    │  │       │  │ Patients      │  │   │  └───────────┘  │
         │  └───────────────┘  │       │  │ Cases/Blocks  │  │   └─────────────────┘
         └─────────────────────┘       │  │ Annotations   │  │
                                       │  │ Sharing       │  │
                                       │  └───────────────┘  │
                                       └─────────────────────┘
```

### Service Components

| Service | Port | Description |
|---------|------|-------------|
| **nginx/viewer** | 80/443 | Static files, reverse proxy, SSL termination |
| **converter** | 8000 (internal) | FastAPI backend, WSI conversion, business logic |
| **orthanc** | 8042 (internal) | DICOM server with DICOMweb API |
| **postgres** | 5432 (internal) | User data, ownership, metadata |
| **redis** | 6379 (internal) | Job queues, session cache |

---

## Features

### 1. WSI Viewing

- **Deep zoom**: Smooth pan/zoom from thumbnail to maximum magnification
- **Tile-based loading**: Efficient loading of gigapixel images
- **Multi-resolution pyramids**: Automatic level selection based on zoom
- **Service Worker caching**: Offline-capable tile cache
- **Keyboard shortcuts**: W/A/S/D navigation, 1-6 zoom presets, F fullscreen

### 2. Format Conversion

| Format | Extension | Scanner | Status |
|--------|-----------|---------|--------|
| Hamamatsu | .ndpi | NanoZoomer | ✅ Full support |
| Aperio | .svs | Leica Aperio | ✅ Full support |
| Philips | .isyntax | IntelliSite | ✅ Full support |
| 3DHistech | .mrxs | Pannoramic | ✅ Full support |
| Leica | .scn | SCN400 | ✅ Full support |
| Ventana | .bif | Roche Ventana | ✅ Full support |
| Generic TIFF | .tif/.tiff | Various | ✅ Full support |

### 3. Slide Management

- **Slide metadata**: Custom display name, stain type (H&E, ER, PR, HER2, etc.)
- **Patient assignment**: Link slides to patient records
- **Case organization**: Group slides by accession number
- **Block tracking**: Tissue block identification

### 4. Sharing & Collaboration

- **Email-based sharing**: Share slides with registered users
- **Permission levels**: View, Annotate, Full access
- **Email notifications**: Automatic notification with slide details
- **Batch sharing**: Share multiple slides at once

### 5. Annotations (Planned)

- Rectangle, ellipse, polygon, freehand drawing
- Measurement tools
- Export to GeoJSON format
- Persistent storage per slide

---

## Slide Hierarchy Model

PathView Pro implements a flexible hierarchy where each level is optional:

```
Patient (optional)
    └── Case / Accession (optional)
            └── Block (optional)
                    └── Slide (always present)
```

### Design Principles

1. **Slides can exist independently**: No patient/case required
2. **Retrospective organization**: Assign hierarchy after upload
3. **Flexible workflows**: Adapt to different lab practices
4. **Editable metadata**: All fields can be updated anytime

### Database Tables

```sql
-- Patients (optional top-level)
patients (id, owner_id, mrn, name, dob, gender)

-- Cases/Accessions (optional)
cases (id, owner_id, patient_id, accession_number, diagnosis)

-- Blocks (optional)
blocks (id, owner_id, case_id, block_id, tissue_type)

-- Slides (core entity)
slides (id, orthanc_study_id, owner_id, display_name, stain,
        patient_id, case_id, block_id, ...)
```

---

## Authentication & Authorization

### Auth0 Integration

PathView Pro uses Auth0 for authentication with JWT tokens.

```javascript
// Frontend: Auth0 SPA SDK
const auth0Client = await auth0.createAuth0Client({
    domain: 'your-tenant.auth0.com',
    clientId: 'your-client-id',
    authorizationParams: {
        audience: 'https://pathviewpro.com/api'
    }
});
```

### Authorization Flow

1. User authenticates via Auth0 (Google, email, etc.)
2. Frontend receives JWT access token
3. Token sent with API requests: `Authorization: Bearer <token>`
4. Backend validates JWT signature and claims
5. User ID extracted from `sub` claim

### User Roles

| Role | Capabilities |
|------|-------------|
| **User** | Upload, view own slides, share with others |
| **Admin** | All user capabilities + manage all slides |

---

## API Reference

### Authentication Required

All endpoints except `/health` require `Authorization: Bearer <token>` header.

### Studies & Slides

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/studies/categorized` | Get owned, shared, sample studies |
| GET | `/api/studies/{id}` | Get study details from Orthanc |
| GET | `/api/slides/{orthanc_id}` | Get slide metadata |
| PUT | `/api/slides/{orthanc_id}` | Update slide metadata |

### Hierarchy Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/patients` | List user's patients |
| POST | `/api/patients` | Create new patient |
| GET | `/api/cases` | List user's cases |
| POST | `/api/cases` | Create new case |
| GET | `/api/blocks` | List user's blocks |
| POST | `/api/blocks` | Create new block |

### Sharing

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/studies/{id}/share` | Share with user by email |
| DELETE | `/api/studies/{id}/share/{user_id}` | Remove share |
| GET | `/api/studies/{id}/shares` | List shares for study |
| POST | `/api/studies/batch-share` | Share multiple studies |

### Upload & Conversion

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload/init` | Initialize chunked upload |
| POST | `/api/upload/{id}/chunk/{n}` | Upload chunk |
| POST | `/api/upload/{id}/complete` | Complete upload & convert |
| GET | `/api/upload/{id}/status` | Get conversion status |

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/me` | Get current user profile |
| PUT | `/api/users/me` | Update user profile |
| GET | `/api/users/search?q=` | Search users for sharing |

---

## Deployment

### Prerequisites

- Docker & Docker Compose v2.0+
- 4GB+ RAM (8GB recommended)
- 50GB+ disk space for WSI storage
- Domain name with SSL certificate

### Production Deployment

```bash
# 1. Clone repository
git clone https://github.com/your-org/dicom-wsi-server.git
cd dicom-wsi-server

# 2. Create environment file
cp config/env.example .env
nano .env  # Edit with your values

# 3. Start services
docker compose up -d

# 4. Run database migrations
docker compose exec postgres psql -U orthanc -d orthanc -f /tmp/user_schema.sql
docker compose exec postgres psql -U orthanc -d orthanc -f /tmp/hierarchy_schema.sql

# 5. Check status
docker compose ps
docker compose logs -f
```

### Required Environment Variables

```bash
# Auth0 (required)
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://pathviewpro.com/api
AUTH0_CLIENT_ID=your-spa-client-id

# Orthanc (required)
ORTHANC_PASSWORD=secure_password_here

# PostgreSQL (required)
POSTGRES_PASSWORD=secure_password_here

# Email notifications (optional)
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your_email
SMTP_PASSWORD=your_smtp_key
SMTP_FROM=noreply@pathviewpro.com
APP_URL=https://pathviewpro.com
```

### SSL/HTTPS Setup

The viewer Dockerfile includes automatic SSL via Let's Encrypt or you can provide your own certificates:

```bash
# Option 1: Let's Encrypt (automatic)
LETSENCRYPT_EMAIL=admin@yourdomain.com

# Option 2: Custom certificates
# Mount to /etc/nginx/ssl/cert.pem and /etc/nginx/ssl/key.pem
```

### Updating

```bash
cd /opt/dicom-wsi-server
git pull
docker compose build --no-cache
docker compose up -d
```

---

## Configuration

### Orthanc Settings

Edit `orthanc/orthanc.json`:

```json
{
    "Name": "PathViewPro",
    "DicomAet": "PATHVIEW",
    "RegisteredUsers": {
        "admin": "your_secure_password"
    },
    "IngestTranscoding": "1.2.840.10008.1.2.1"
}
```

### Nginx Settings

Edit `viewer/nginx.conf` for:
- CORS headers
- Upload size limits
- Proxy timeouts
- Cache settings

### Converter Settings

Environment variables in `docker-compose.yml`:

```yaml
converter:
  environment:
    - MAX_UPLOAD_SIZE_GB=20
    - CONVERSION_TIMEOUT=3600
```

---

## Database Schema

### Core Tables

```sql
-- Users (synced from Auth0)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    picture TEXT,
    role VARCHAR(50) DEFAULT 'user'
);

-- Slides (core entity)
CREATE TABLE slides (
    id SERIAL PRIMARY KEY,
    orthanc_study_id VARCHAR(255) UNIQUE NOT NULL,
    owner_id INTEGER REFERENCES users(id),
    display_name VARCHAR(255),
    stain VARCHAR(50),
    patient_id INTEGER REFERENCES patients(id),
    case_id INTEGER REFERENCES cases(id),
    block_id INTEGER REFERENCES blocks(id)
);

-- Slide sharing
CREATE TABLE slide_shares (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER REFERENCES slides(id),
    owner_id INTEGER REFERENCES users(id),
    shared_with_id INTEGER REFERENCES users(id),
    permission VARCHAR(50) DEFAULT 'view'
);

-- Annotations
CREATE TABLE annotations (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER REFERENCES slides(id),
    user_id INTEGER REFERENCES users(id),
    type VARCHAR(50),
    geometry JSONB,
    properties JSONB
);
```

---

## Email Notifications

### Configuration

Set SMTP environment variables:

```bash
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your_email@domain.com
SMTP_PASSWORD=your_smtp_key
SMTP_FROM=noreply@pathviewpro.com
APP_URL=https://pathviewpro.com
```

### Supported Providers

| Provider | SMTP_HOST | Notes |
|----------|-----------|-------|
| **Brevo** | smtp-relay.brevo.com | Recommended, generous free tier |
| **SendGrid** | smtp.sendgrid.net | SMTP_USER=apikey |
| **AWS SES** | email-smtp.region.amazonaws.com | Requires verified domain |
| **Gmail** | smtp.gmail.com | Requires app password |

### Email Types

1. **Share Notification**: Sent when a slide is shared
   - Recipient name and email
   - Sharer information
   - Slide details (name, stain, patient, case)
   - Direct link to view slide

---

## SpaceMouse Integration

### Supported Devices

- 3Dconnexion SpaceMouse Compact
- 3Dconnexion SpaceMouse Pro
- 3Dconnexion SpaceMouse Enterprise

### Connection Methods

1. **WebHID** (recommended): Direct USB, no drivers needed
2. **3DxWare**: Via local WebSocket driver
3. **Gamepad API**: Fallback for wireless models

### Navigation Controls

| Input | Action |
|-------|--------|
| Push X/Y | Pan horizontally/vertically |
| Twist Z clockwise | Zoom in |
| Twist Z counter-clockwise | Zoom out |
| Press down (tap) | Toggle fullscreen |
| Left button | Previous slide |
| Right button | Next slide |

### Status Indicator

- 🟢 Green: WebHID connected
- 🟠 Orange: 3DxWare connected
- ⚫ Gray: Gamepad/disabled

---

## Troubleshooting

### Common Issues

#### "Failed to load studies"

```bash
# Check converter logs
docker compose logs converter --tail=50

# Verify database connection
docker compose exec postgres psql -U orthanc -d orthanc -c "SELECT COUNT(*) FROM slides;"
```

#### "Upload failed: 500 error"

```bash
# Check upload directory permissions
docker compose exec converter ls -la /uploads

# Check converter logs
docker compose logs converter --tail=100 | grep -i error
```

#### "Tiles not loading"

```bash
# Verify Orthanc has the study
docker compose exec converter curl -u admin:password http://orthanc:8042/studies

# Check nginx proxy logs
docker compose logs viewer --tail=50
```

#### "Email not sending"

```bash
# Verify SMTP configuration
docker compose exec converter env | grep SMTP

# Check for email errors
docker compose logs converter --tail=50 | grep -i email
```

### Health Checks

```bash
# All services status
docker compose ps

# Individual service health
curl https://pathviewpro.com/api/health
curl https://pathviewpro.com/dicom-web/studies
```

### Performance Tuning

```bash
# Increase upload timeout (nginx.conf)
proxy_read_timeout 7200s;

# Increase converter workers (for multiple CPUs)
uvicorn main:app --workers 4

# PostgreSQL tuning (postgresql-tuning.conf)
shared_buffers = 256MB
effective_cache_size = 1GB
```

---

## Support & Resources

- **GitHub Issues**: Report bugs and feature requests
- **Documentation**: `/docs` folder in repository
- **API Docs**: https://pathviewpro.com/api/docs (Swagger UI)

---

*PathView Pro - Professional Digital Pathology Viewing Platform*
