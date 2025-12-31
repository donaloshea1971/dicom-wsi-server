# DICOM Server Project Summary

## Overview

A comprehensive DICOM Whole Slide Imaging (WSI) server system that enables viewing, converting, and managing digital pathology images. The system supports both native DICOM WSI files and proprietary formats (Ventana BIF, Philips iSyntax, 3DHISTECH) through automatic conversion.

## Architecture

### Core Components

1. **Orthanc DICOM Server**
   - Lightweight, RESTful DICOM server
   - WSI plugin for pyramid tile serving
   - DICOMweb support (QIDO-RS, WADO-RS, STOW-RS)
   - PostgreSQL database for metadata storage
   - Configured with disabled IngestTranscoding for large WSI files

2. **OpenSeadragon Viewer**
   - High-performance deep zoom viewer
   - Custom WSI TileSource implementation
   - Multi-resolution pyramid support
   - Metadata display modal
   - Performance optimizations (caching, parallel loading)

3. **Format Converter Service**
   - FastAPI-based REST API
   - Supports Ventana BIF, Philips iSyntax, 3DHISTECH formats
   - Uses wsidicomizer for DICOM WSI generation
   - Asynchronous job processing with progress tracking
   - Automatic upload to Orthanc after conversion

4. **Nginx Reverse Proxy**
   - Request routing and load balancing
   - Tile caching for performance
   - Unified API endpoint
   - 24-hour cache for WSI tiles

## Key Features

### 1. Multi-Format Support
- **Native DICOM WSI**: Direct viewing of standard DICOM WSI files
- **Ventana BIF**: Automatic conversion using wsidicomizer
- **Philips iSyntax**: Full pyramid conversion via pyisyntax integration
- **3DHISTECH**: Support through wsidicomizer (with some limitations)

### 2. High-Performance Viewing
- **Tiled Image Loading**: Efficient loading of gigapixel images
- **Multi-Resolution Pyramids**: Seamless zooming from thumbnail to full resolution
- **Client-Side Caching**: Browser-based tile caching
- **Server-Side Caching**: Nginx proxy cache for tiles
- **Parallel Tile Loading**: Optimized concurrent requests

### 3. Metadata Management
- **DICOM Tag Display**: Full access to DICOM metadata
- **Scanner Information**: Manufacturer, model, acquisition details
- **Source Detection**: Identifies native vs converted images
- **Interactive Modal**: Easy-to-use metadata viewer

### 4. Conversion Pipeline
- **Automatic Detection**: File format identification
- **Progress Tracking**: Real-time conversion status
- **Error Handling**: Graceful failure recovery
- **Job Management**: Async processing with status API

## Technologies Used

### Backend
- **Python 3.11**: Core programming language
- **FastAPI**: Modern async web framework
- **wsidicomizer**: WSI to DICOM conversion library
- **pyisyntax**: Philips iSyntax file reader
- **pydicom**: DICOM file manipulation
- **highdicom**: DICOM object creation
- **Pillow**: Image processing
- **httpx**: Async HTTP client

### Frontend
- **OpenSeadragon 4.1.1**: Deep zoom viewer
- **Vanilla JavaScript**: Core interactivity
- **HTML5/CSS3**: Modern web standards
- **Bootstrap Icons**: UI elements

### Infrastructure
- **Docker/Docker Compose**: Container orchestration
- **Nginx**: Web server and reverse proxy
- **PostgreSQL**: Database for Orthanc
- **Orthanc**: DICOM server
- **DICOMweb**: Standard web API for DICOM

## Implementation Highlights

### 1. Custom WSI TileSource
```javascript
// Custom OpenSeadragon TileSource for WSI pyramids
class WsiTileSource extends OpenSeadragon.TileSource {
    // Maps OpenSeadragon levels to WSI pyramid levels
    // Handles tile URL generation with bounds checking
    // Supports multi-resolution viewing
}
```

### 2. iSyntax Conversion
```python
# Leverages wsidicomizer's native iSyntax support
from wsidicomizer import WsiDicomizer
wsi = WsiDicomizer.open(isyntax_path)
wsi.save(output_dir)
```

### 3. Asynchronous Processing
- Background job processing for large file conversions
- Progress tracking and status updates
- Non-blocking API design

### 4. Performance Optimizations
- Tile request batching
- Cache-Control headers
- Lazy loading strategies
- Resolution-based loading priorities

## Current Capabilities

1. **View DICOM WSI files** with smooth pan/zoom
2. **Convert proprietary formats** to standard DICOM
3. **Display comprehensive metadata** including scanner details
4. **Handle gigapixel images** efficiently
5. **Support multiple concurrent users**
6. **Cache tiles for performance**
7. **Track conversion progress** in real-time

## Known Limitations

1. **3DHISTECH**: Some files may not display properly due to format variations
2. **Large Files**: Very large conversions (>1GB) may take significant time
3. **Memory Usage**: High-resolution viewing requires adequate client memory
4. **Browser Compatibility**: Best performance in modern browsers

## API Endpoints

### Viewer API
- `GET /studies` - List available studies
- `GET /series/{study_id}` - Get series for a study
- `GET /wsi/tiles/{series_id}/{level}/{col}/{row}` - Get image tile
- `GET /pyramid/{series_id}` - Get pyramid metadata

### Converter API
- `POST /api/upload` - Upload file for conversion
- `GET /api/jobs/{job_id}` - Check conversion status
- `GET /api/formats` - List supported formats

### DICOMweb API
- Standard QIDO-RS, WADO-RS endpoints via Orthanc

## Deployment

The system is containerized and can be deployed using Docker Compose:

```bash
docker-compose up -d
```

Services start on:
- Viewer: http://localhost:3000
- Orthanc: http://localhost:8042
- Converter API: http://localhost:8000 (internal)

## Recent Enhancements

1. **Metadata Modal**: Added interactive "i" button for viewing DICOM tags
2. **iSyntax Support**: Full implementation of Philips format conversion with custom pyramid generator
3. **Performance Tuning**: Nginx caching and viewer optimizations
4. **Error Handling**: Improved resilience for edge cases
5. **Multi-Level Support**: Fixed alignment issues in pyramid viewing
6. **Custom iSyntax Converter**: Implemented enhanced converter that properly generates multi-resolution pyramids
   - Detects all 8 levels in iSyntax files (vs. wsidicomizer's single level)
   - Generates proper tiled DICOM WSI format
   - Memory-efficient batch processing for large images
   - Full pyramid support for OpenSeadragon viewer

## Leica Multi-File Pyramid Support

Leica scanners create separate DICOM files for each resolution level instead of a single multi-resolution pyramid. The system handles this through:

### Components
- **`converter/leica_pyramid_builder.py`**: Identifies and groups Leica files by resolution
- **`converter/leica_aggregator.py`**: Creates virtual aggregated series from multiple files  
- **`/api/leica-pyramid/{study_id}`**: API endpoint that returns virtual pyramid metadata
- **Viewer Enhancement**: Modified WsiTileSource to render multi-file pyramids as a single image

### How It Works
1. When standard WSI pyramid is not available, viewer checks for Leica multi-file format
2. API aggregates all SM (Slide Microscopy) instances in a study
3. Instances are sorted by resolution to create virtual pyramid levels
4. Viewer renders tiles from individual instances based on zoom level

## Future Considerations

1. **Additional Formats**: Support for more proprietary formats
2. **Annotation Tools**: Drawing and measurement capabilities
3. **AI Integration**: Pathology analysis features
4. **User Management**: Authentication and authorization
5. **Cloud Storage**: S3/Azure blob support
6. **PACS Integration**: Full clinical workflow support
7. **Automated Leica Aggregation**: Background service to automatically detect and aggregate Leica multi-file pyramids
