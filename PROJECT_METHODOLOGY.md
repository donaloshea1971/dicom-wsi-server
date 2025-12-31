# DICOM Pathology WSI Server - Project Methodology

## Executive Summary
Build a vendor-neutral DICOM WSI server with OpenSeadragon viewer for testing Diagnexia's pathology workflows. Focus on rapid iteration, standards compliance, and scanner compatibility (Philips, Hamamatsu, Sectra).

**Timeline:** 4-6 weeks to functional MVP  
**Tech Stack:** Orthanc (server) + Custom OpenSeadragon (viewer) + Python (conversion/utilities)  
**Deployment:** Docker containers on cloud infrastructure

---

## Project Phases

### Phase 1: Foundation Setup (Week 1)
**Goal:** Working DICOM server accepting proprietary formats

#### Deliverables
1. Orthanc server with DICOMweb plugin running in Docker
2. Basic file upload endpoint
3. Format converter (wsidicomizer) containerized
4. PostgreSQL database configured
5. Health check endpoints

#### Tasks
- [ ] Set up Docker Compose stack (Orthanc + PostgreSQL + Redis)
- [ ] Configure Orthanc with DICOMweb, WSI, and PostgreSQL plugins
- [ ] Create Python service for format conversion (Philips iSyntax, Hamamatsu NDPI, Leica SVS)
- [ ] Build upload API endpoint (REST) for proprietary formats
- [ ] Implement automatic conversion pipeline (watch folder → convert → STOW-RS)
- [ ] Configure CORS for browser access
- [ ] Set up basic authentication

#### Success Criteria
- Upload NDPI file → stored as DICOM in Orthanc
- QIDO-RS returns study metadata
- WADO-RS retrieves individual frames
- Server handles 1GB+ files without issues

---

### Phase 2: OpenSeadragon Integration (Week 2)
**Goal:** Browser-based viewer rendering DICOM WSI tiles

#### Deliverables
1. Custom OpenSeadragon TileSource for DICOMweb
2. Basic HTML viewer application
3. Metadata parser for pyramid structure
4. Level mapping (DICOM ↔ OpenSeadragon)

#### Tasks
- [ ] Create custom OSD TileSource class
- [ ] Implement frame number calculator (level, x, y → frame #)
- [ ] Build metadata retrieval service (QIDO-RS + WADO-RS metadata)
- [ ] Parse DICOM TotalPixelMatrix dimensions
- [ ] Handle PerFrameFunctionalGroupsSequence for tile positions
- [ ] Implement pyramid level reversal logic
- [ ] Create simple web UI (study selector + viewer)
- [ ] Add zoom/pan controls and overview map

#### Success Criteria
- Load DICOM WSI in browser
- Smooth pan/zoom at all levels
- Correct tile alignment
- No missing tiles (404 errors)
- Renders 40X magnification images

---

### Phase 3: Multi-Scanner Support (Week 3)
**Goal:** Handle outputs from all major scanners

#### Deliverables
1. Conversion profiles for each scanner type
2. Metadata enrichment pipeline
3. Quality validation checks
4. Test suite with real scanner outputs

#### Tasks
- [ ] Test with Philips iSyntax files
- [ ] Test with Hamamatsu NDPI files
- [ ] Test with Leica Aperio SVS files
- [ ] Test with Sectra outputs
- [ ] Handle different tile sizes (256, 512, 1024)
- [ ] Support both JPEG and JPEG2000 compression
- [ ] Validate pyramid structure for each vendor
- [ ] Add macroscopic/label image handling
- [ ] Implement format-specific metadata extraction
- [ ] Create scanner compatibility matrix

#### Success Criteria
- Successfully convert and view files from 3+ scanner types
- Preserve all metadata during conversion
- Handle edge cases (Z-stacks, fluorescence)
- Generate quality report for each upload

---

### Phase 4: Performance Optimization (Week 4)
**Goal:** Production-ready performance and reliability

#### Deliverables
1. Tile caching layer (Redis)
2. Concurrent frame retrieval
3. Progressive loading implementation
4. Load testing results
5. Monitoring dashboard

#### Tasks
- [ ] Implement Redis tile cache
- [ ] Add HTTP caching headers (ETag, Cache-Control)
- [ ] Enable concurrent WADO-RS frame requests
- [ ] Implement progressive rendering (load overview first)
- [ ] Add request batching for adjacent tiles
- [ ] Configure connection pooling
- [ ] Set up Prometheus metrics
- [ ] Add Grafana dashboards
- [ ] Run load tests (Locust/k6)
- [ ] Optimize database queries

#### Performance Targets
- Time to first tile: <500ms
- Tile retrieval: <100ms per tile
- Support 10+ concurrent viewers
- Handle 100+ studies in archive

---

### Phase 5: Production Hardening (Weeks 5-6)
**Goal:** Deploy-ready system with proper error handling

#### Deliverables
1. Comprehensive error handling
2. Admin interface
3. Backup/restore procedures
4. Documentation
5. CI/CD pipeline

#### Tasks
- [ ] Add comprehensive logging (structured JSON)
- [ ] Implement error recovery for failed conversions
- [ ] Build admin UI (study management, stats)
- [ ] Create backup scripts for PostgreSQL + DICOM storage
- [ ] Write API documentation (OpenAPI/Swagger)
- [ ] Document deployment procedures
- [ ] Set up GitHub Actions CI/CD
- [ ] Implement health checks and alerts
- [ ] Add user authentication/authorization
- [ ] Security audit (OWASP top 10)

#### Success Criteria
- 99.9% uptime
- All errors logged with context
- Recovery from failures without data loss
- Complete deployment docs
- Security best practices implemented

---

## Technology Stack

### Core Components
```
┌─────────────────────────────────────────────────┐
│  Frontend Layer                                  │
│  • OpenSeadragon (viewer)                       │
│  • React/Vue (optional UI framework)            │
│  • Custom DICOMweb TileSource                   │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  API Gateway / Load Balancer                    │
│  • NGINX (reverse proxy, SSL, caching)         │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  Conversion Service                              │
│  • Python FastAPI                               │
│  • wsidicomizer library                         │
│  • OpenSlide (fallback reader)                  │
│  • Celery (async job queue)                     │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  DICOM Server                                    │
│  • Orthanc v1.12+                               │
│  • DICOMweb plugin                              │
│  • WSI plugin (optional viewer)                 │
│  • PostgreSQL plugin                            │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│  Storage & Cache Layer                          │
│  • PostgreSQL (metadata)                        │
│  • S3/MinIO (DICOM files)                       │
│  • Redis (tile cache)                           │
└─────────────────────────────────────────────────┘
```

### Development Stack
- **Language:** Python 3.11+ (backend), JavaScript/TypeScript (frontend)
- **Framework:** FastAPI (conversion service), Express/Koa (optional proxy)
- **Database:** PostgreSQL 15+ (Orthanc metadata)
- **Cache:** Redis 7+ (tile caching)
- **Container:** Docker + Docker Compose
- **Orchestration:** Docker Swarm or Kubernetes (production)
- **CI/CD:** GitHub Actions
- **Monitoring:** Prometheus + Grafana
- **Logging:** ELK Stack or Loki

---

## Architecture Decisions

### Why Orthanc?
✅ Mature, stable, well-documented  
✅ Built-in DICOMweb support  
✅ Plugin architecture  
✅ Active community  
✅ Battle-tested in production  
✅ Lightweight (vs DCM4CHEE)  

**Alternative considered:** DCM4CHEE (rejected: too heavyweight for MVP)

### Why wsidicomizer?
✅ Open source, MIT licensed  
✅ Supports all major scanner formats  
✅ Lossless conversion where possible  
✅ Active development (Sectra/BigPicture project)  
✅ Python-based (easy integration)  

### Why OpenSeadragon?
✅ Industry standard for WSI  
✅ Proven at scale  
✅ Active development  
✅ Plugin ecosystem  
✅ Mobile-friendly  
✅ Used by Google, PathPresenter, DigitalSlideArchive  

**Alternative considered:** Slim (MGH viewer) - good but more specialized for research

### Storage Strategy
**Development:** Local filesystem  
**Production:** S3-compatible object storage (MinIO/AWS S3)  

**Rationale:** Object storage scales better, enables CDN, supports multi-region

---

## Critical Implementation Details

### Frame Number Calculation
```python
def calculate_frame_number(level, x, y, pyramid_metadata):
    """
    Map OpenSeadragon tile coordinates to DICOM frame number
    
    Args:
        level: OSD pyramid level (0 = lowest res, N = highest)
        x, y: Tile coordinates at this level
        pyramid_metadata: Parsed DICOM metadata
    
    Returns:
        1-based DICOM frame number
    """
    # Reverse level (DICOM uses opposite convention)
    dicom_level = pyramid_metadata['max_level'] - level
    
    # Get dimensions at this level
    level_info = pyramid_metadata['levels'][dicom_level]
    tiles_per_row = level_info['tiles_per_row']
    
    # Calculate offset from previous levels
    frame_offset = level_info['frame_offset']
    
    # Compute frame number (DICOM uses 1-based indexing)
    frame_number = frame_offset + (y * tiles_per_row) + x + 1
    
    return frame_number
```

### Metadata Parsing Strategy
```python
def parse_wsi_metadata(dicom_json):
    """
    Extract pyramid structure from DICOM metadata
    
    Returns structured metadata for TileSource initialization
    """
    metadata = {
        'width': dicom_json['TotalPixelMatrixColumns'],
        'height': dicom_json['TotalPixelMatrixRows'],
        'tile_size': dicom_json['Columns'],  # Tile width
        'levels': []
    }
    
    # Parse each pyramid level from SharedFunctionalGroupsSequence
    # or PerFrameFunctionalGroupsSequence
    
    return metadata
```

### OpenSeadragon TileSource
```javascript
class DicomWebTileSource extends OpenSeadragon.TileSource {
  constructor(options) {
    super(options);
    this.studyUID = options.studyUID;
    this.seriesUID = options.seriesUID;
    this.instanceUID = options.instanceUID;
    this.baseUrl = options.baseUrl;
    this.pyramid = options.pyramidMetadata;
  }
  
  getTileUrl(level, x, y) {
    const frameNumber = this.calculateFrameNumber(level, x, y);
    
    return `${this.baseUrl}/studies/${this.studyUID}` +
           `/series/${this.seriesUID}` +
           `/instances/${this.instanceUID}` +
           `/frames/${frameNumber}`;
  }
  
  getTileAjaxHeaders() {
    return {
      'Accept': 'image/jpeg',
      'Authorization': `Bearer ${this.token}`
    };
  }
  
  calculateFrameNumber(level, x, y) {
    // Implementation from Python example above
  }
}
```

---

## Testing Strategy

### Unit Tests
- Frame number calculation logic
- Metadata parsing
- Level mapping
- Format detection

### Integration Tests
- Upload → Convert → Store workflow
- QIDO-RS queries
- WADO-RS frame retrieval
- Viewer rendering

### System Tests
- End-to-end: Upload scanner file → View in browser
- Multi-scanner compatibility
- Large file handling (>5GB)
- Concurrent user simulation

### Load Tests
- 100 concurrent tile requests
- 10 simultaneous viewers
- Upload during active viewing
- Cache effectiveness

### Test Data
- Philips iSyntax samples (from Philips)
- Hamamatsu NDPI (from OpenSlide)
- Leica Aperio SVS (TCGA public data)
- Sectra outputs (from customer/partner)

---

## Deployment Architecture

### Development Environment
```yaml
# docker-compose.yml
services:
  orthanc:
    image: jodogne/orthanc-plugins:latest
    ports: ["8042:8042"]
    volumes: ["./orthanc.json:/etc/orthanc/orthanc.json"]
    
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: orthanc
      
  redis:
    image: redis:7-alpine
    
  converter:
    build: ./converter
    volumes: ["./uploads:/uploads"]
    environment:
      ORTHANC_URL: http://orthanc:8042
      
  viewer:
    build: ./viewer
    ports: ["3000:80"]
```

### Production Environment
**Cloud Provider:** AWS/Azure/GCP  
**Compute:** ECS Fargate or GKE  
**Storage:** S3/Azure Blob/GCS  
**Database:** Managed PostgreSQL (RDS/CloudSQL)  
**Cache:** ElastiCache Redis  
**CDN:** CloudFront/Azure CDN  
**DNS:** Route53/Cloud DNS  
**SSL:** AWS Certificate Manager / Let's Encrypt  

**Estimated Monthly Cost (moderate usage):**
- Compute: $200-400
- Storage: $50-200 (1TB)
- Database: $100-200
- Cache: $50
- Data transfer: $100-300
- **Total: ~$500-1200/month**

---

## Security Considerations

### Authentication & Authorization
- JWT tokens for API access
- OAuth2/OIDC for SSO integration
- Role-based access control (RBAC)
- API key management for scanner integration

### Data Security
- TLS 1.3 for all connections
- Encryption at rest (AES-256)
- Regular security updates
- HIPAA compliance considerations (if applicable)

### Network Security
- VPC isolation
- Security groups / firewall rules
- DDoS protection (CloudFlare/AWS Shield)
- Rate limiting

---

## Monitoring & Observability

### Key Metrics
- **Server Health:** CPU, memory, disk usage
- **Performance:** Tile response time, conversion time
- **Business:** Studies uploaded, viewers active, errors
- **Storage:** Space used, growth rate

### Alerts
- Server down (5xx errors)
- Conversion failures
- Disk space >80%
- Response time >1s
- Failed authentication attempts

### Logging
```json
{
  "timestamp": "2025-12-27T10:30:00Z",
  "level": "INFO",
  "service": "converter",
  "event": "conversion_complete",
  "study_uid": "1.2.3...",
  "scanner_type": "hamamatsu_ndpi",
  "file_size_mb": 2048,
  "duration_sec": 45.3
}
```

---

## Risk Mitigation

### Technical Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Scanner format changes | High | Version detection, fallback converters |
| Large file OOM | Medium | Streaming processing, memory limits |
| Slow conversions | Medium | Async queue, progress tracking |
| Tile cache overflow | Low | LRU eviction, size limits |

### Operational Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Data loss | Critical | Daily backups, replication |
| Downtime | High | Health checks, auto-restart |
| Cost overrun | Medium | Budget alerts, usage monitoring |

---

## Success Criteria

### MVP Definition
✅ Upload proprietary WSI files  
✅ Convert to DICOM automatically  
✅ View in browser with smooth pan/zoom  
✅ Support 3+ scanner types  
✅ Handle files up to 10GB  
✅ <2 second load time for viewer  
✅ Basic authentication  
✅ Documented API  

### Production Readiness
✅ All MVP criteria  
✅ 99.9% uptime  
✅ Automated backups  
✅ Monitoring & alerting  
✅ Security hardened  
✅ Load tested (100+ concurrent users)  
✅ Documentation complete  
✅ CI/CD pipeline  

---

## Development Workflow

### Git Strategy
- `main` branch: production-ready code
- `develop` branch: integration branch
- Feature branches: `feature/viewer-optimization`
- Release branches: `release/v1.0`

### Code Review
- All changes via pull request
- Require 1 approval
- Automated tests must pass
- Security scan (Snyk/Dependabot)

### Release Process
1. Create release branch
2. Version bump, changelog
3. QA testing
4. Deploy to staging
5. Smoke tests
6. Deploy to production
7. Tag release

---

## Documentation Deliverables

1. **README.md** - Quick start guide
2. **ARCHITECTURE.md** - System design
3. **API.md** - OpenAPI specification
4. **DEPLOYMENT.md** - Setup instructions
5. **OPERATIONS.md** - Runbook
6. **DEVELOPMENT.md** - Contributing guide

---

## Next Actions

### Immediate (This Week)
1. Set up GitHub repository
2. Initialize Cursor project
3. Create Docker Compose stack
4. Configure Orthanc with plugins
5. Test basic DICOM upload

### Short Term (Next 2 Weeks)
1. Build conversion service
2. Implement OpenSeadragon viewer
3. Test with real scanner files
4. Document APIs

### Medium Term (Weeks 3-6)
1. Performance optimization
2. Production deployment
3. Load testing
4. Security hardening

---

## Appendix: Useful Resources

### Documentation
- DICOM Standard: https://dicom.nema.org/
- Orthanc Book: https://book.orthanc-server.com/
- OpenSeadragon API: https://openseadragon.github.io/docs/
- DICOMweb: https://www.dicomstandard.org/using/dicomweb

### Code Examples
- Google WSI Viewer: https://github.com/GoogleCloudPlatform/dicomweb-wsi-viewer
- wsidicomizer: https://github.com/imi-bigpicture/wsidicomizer
- Slim Viewer (MGH): https://github.com/MGHComputationalPathology/slim

### Test Data
- OpenSlide: https://openslide.org/
- TCGA: https://portal.gdc.cancer.gov/
- NCI Imaging Data Commons: https://imaging.datacommons.cancer.gov/

### Community
- Orthanc Users Group: https://groups.google.com/g/orthanc-users
- DICOM WG-26 (Pathology): https://www.dicomstandard.org/
- Digital Pathology Association: https://digitalpathologyassociation.org/

---

**Document Version:** 1.0  
**Last Updated:** 2025-12-27  
**Owner:** Deciphex Engineering  
**Status:** Active Development

