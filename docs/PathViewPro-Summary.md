# PathView Pro - Whole Slide Image Viewer

## Overview

PathView Pro is a web-based digital pathology viewer that converts and displays Whole Slide Images (WSI) in a browser. It provides high-performance viewing of gigapixel pathology images with intuitive navigation controls, including support for 3Dconnexion SpaceMouse 6DOF input devices.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         NGINX (Reverse Proxy)                   │
│                     pathviewpro.com (HTTPS)                     │
└─────────────────┬─────────────────────────┬─────────────────────┘
                  │                         │
                  ▼                         ▼
┌─────────────────────────┐   ┌─────────────────────────────────┐
│     Viewer (Static)     │   │    Converter API (FastAPI)      │
│  - OpenSeadragon        │   │  - WSI → DICOM conversion       │
│  - SpaceMouse WebHID    │   │  - Auth0 JWT authentication     │
│  - Auth0 integration    │   │  - Study ownership management   │
└─────────────────────────┘   └──────────────┬──────────────────┘
                                             │
                              ┌──────────────┴──────────────┐
                              ▼                              ▼
                ┌─────────────────────┐      ┌─────────────────────┐
                │   Orthanc (DICOM)   │      │  PostgreSQL         │
                │  - DICOM storage    │      │  - User accounts    │
                │  - DICOMweb API     │      │  - Study ownership  │
                └─────────────────────┘      └─────────────────────┘
```

## Key Features

### 1. WSI Conversion Pipeline
- **Input formats**: SVS, NDPI, TIFF, and other common WSI formats
- **Output**: DICOM (standard medical imaging format)
- **Process**: Automatic pyramid tiling for efficient multi-resolution viewing
- **Storage**: Orthanc DICOM server with DICOMweb API

### 2. High-Performance Viewer
- **OpenSeadragon**: Industry-standard deep zoom image viewer
- **Tile-based loading**: Only loads visible tiles at current resolution
- **Multi-resolution support**: Seamless zoom from thumbnail to maximum magnification
- **Responsive**: Works on desktop and tablet devices

### 3. User Authentication & Ownership
- **Auth0 integration**: Secure OAuth2/OIDC authentication
- **Study ownership**: Users own their uploaded images
- **Sample content**: New users see sample images to explore the platform
- **Sharing** (planned): Share studies with other users

### 4. SpaceMouse Integration (WebHID)

A unique feature providing intuitive 6DOF (six degrees of freedom) navigation for pathologists.

#### How It Works
- **WebHID API**: Direct browser-to-USB communication (no drivers required)
- **No installation**: Works in Chrome/Edge/Brave on Windows, Mac, Linux
- **Real-time input**: 60fps animation loop for smooth navigation

#### Input Mapping
| SpaceMouse Action | Viewer Action |
|-------------------|---------------|
| Push left/right (TX) | Pan horizontally |
| Push forward/back (TY) | Pan vertically |
| Tilt (RX/RY) | Assists panning (tilt-assist mode) |
| Twist left (RZ < -200) | Zoom out 0.5x |
| Twist right (RZ > 200) | Zoom in 2x |
| Left button | Previous study |
| Right button | Next study |

#### Smart Features
- **Tilt Assist**: Inadvertent tilt reinforces intentional pan direction
- **Exponential curve**: Subtle inputs = fine control, hard push = fast movement
- **Momentum**: Smooth deceleration when releasing input
- **Moving average**: 25-sample smoothing for diagonal motion
- **Auto-connect**: Remembers paired devices
- **Crosshair**: Visual center indicator for navigation

#### Tunable Parameters (Real-time Config Panel)
- Pan sensitivity
- Deadzone (default: 0.25)
- Curve power (default: 1.2)
- History size (default: 25)
- Smoothing factor
- Momentum decay
- Tilt mode & weight
- Axis inversion

## Technology Stack

| Component | Technology |
|-----------|------------|
| Frontend | HTML5, JavaScript, OpenSeadragon |
| SpaceMouse | WebHID API |
| Backend API | Python, FastAPI |
| WSI Conversion | OpenSlide, wsidicom |
| DICOM Server | Orthanc |
| Database | PostgreSQL |
| Auth | Auth0 (JWT) |
| Proxy | NGINX |
| Deployment | Docker Compose |
| Hosting | DigitalOcean |

## Browser Support

| Browser | SpaceMouse | Viewer |
|---------|------------|--------|
| Chrome | ✅ | ✅ |
| Edge | ✅ | ✅ |
| Brave | ✅ | ✅ |
| Firefox | ❌ (no WebHID) | ✅ |
| Safari | ❌ (no WebHID) | ✅ |

## Deployment

The application runs as a Docker Compose stack:

```bash
docker compose up -d
```

Services:
- `viewer` - Static file server (NGINX)
- `converter` - FastAPI conversion service
- `orthanc` - DICOM server
- `postgres` - Database

## Security

- HTTPS enforced via NGINX
- Auth0 JWT token verification
- CORS configured for API endpoints
- User data isolation (users only see their own studies + samples)

## Future Roadmap

- [ ] Study sharing between users
- [ ] Annotation tools
- [ ] AI-assisted analysis integration
- [ ] Multi-focal plane (Z-stack) support using TZ axis
- [ ] Mobile touch gestures

---

*Version: 1.0.11 | SpaceMouse Module: 1.9.12*
