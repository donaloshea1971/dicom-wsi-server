"""
DICOM WSI Conversion Service
Converts proprietary WSI formats to DICOM and uploads to Orthanc
"""

import os
import uuid
import shutil
import asyncio
from pathlib import Path
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from pydantic_settings import BaseSettings

import httpx
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    orthanc_url: str = "http://orthanc:8042"
    orthanc_username: str = "admin"
    orthanc_password: str = "orthanc"
    redis_url: str = "redis://redis:6379"
    watch_folder: str = "/uploads"
    max_upload_size_gb: int = 20

    class Config:
        env_file = ".env"


settings = Settings()

# Track conversion jobs
conversion_jobs: dict = {}


class ConversionJob(BaseModel):
    job_id: str
    filename: str
    status: str  # pending, processing, completed, failed
    progress: int = 0
    message: str = ""
    study_uid: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None


class UploadResponse(BaseModel):
    job_id: str
    message: str
    status: str


# =============================================================================
# LZW/Unsupported Compression Handling
# =============================================================================

def check_tiff_compression(file_path: Path) -> tuple[bool, int]:
    """
    Check if a TIFF/SVS file uses LZW or other unsupported compression.
    Returns (needs_conversion, compression_type)
    
    TIFF Compression codes:
    - 1: Uncompressed
    - 5: LZW (not supported by OpenSlide)
    - 6: JPEG (old-style)
    - 7: JPEG (new-style, supported)
    - 8: Adobe Deflate
    - 32773: PackBits
    - 33003: JPEG2000 (supported by OpenSlide with plugins)
    - 33005: JPEG2000 (supported by OpenSlide with plugins)
    """
    try:
        import tifffile
        with tifffile.TiffFile(str(file_path)) as tif:
            # Check all pages for compression
            unsupported_compressions = {5, 6, 8, 32773}  # LZW, old JPEG, Deflate, PackBits
            for page in tif.pages:
                compression = page.compression
                if isinstance(compression, int) and compression in unsupported_compressions:
                    logger.info(f"Found unsupported compression {compression} in {file_path.name}")
                    return True, compression
                # tifffile uses enum, check value
                if hasattr(compression, 'value') and compression.value in unsupported_compressions:
                    logger.info(f"Found unsupported compression {compression.value} in {file_path.name}")
                    return True, compression.value
        return False, 0
    except Exception as e:
        logger.warning(f"Could not check TIFF compression: {e}")
        return False, 0


def convert_to_jpeg_tiff(source_path: Path, output_dir: Path) -> Path:
    """
    Convert a TIFF with unsupported compression (LZW, Deflate, etc.) 
    to a JPEG-compressed pyramid TIFF using pyvips.
    
    This creates a proper pyramid TIFF that OpenSlide/wsidicomizer can read.
    """
    import pyvips
    
    logger.info(f"Pre-processing {source_path.name} - converting to JPEG compression...")
    
    output_path = output_dir / f"{source_path.stem}_jpeg.tiff"
    
    # Load image with pyvips (handles LZW natively)
    image = pyvips.Image.new_from_file(str(source_path), access='sequential')
    
    logger.info(f"Loaded image: {image.width}x{image.height}, {image.bands} bands")
    
    # Save as pyramid TIFF with JPEG compression
    # tile=True creates tiled TIFF
    # pyramid=True creates multi-resolution pyramid
    # compression='jpeg' uses JPEG for tiles
    # Q=90 sets JPEG quality
    image.tiffsave(
        str(output_path),
        tile=True,
        tile_width=256,
        tile_height=256,
        pyramid=True,
        compression='jpeg',
        Q=90,
        bigtiff=True  # Support files > 4GB
    )
    
    logger.info(f"Created JPEG-compressed pyramid TIFF: {output_path}")
    return output_path


def preprocess_for_conversion(file_path: Path, output_dir: Path, job=None) -> Path:
    """
    Pre-process a WSI file if it uses unsupported compression.
    Returns the path to use for conversion (may be original or converted file).
    """
    # Only check TIFF-based formats
    ext = file_path.suffix.lower()
    if ext not in ['.tiff', '.tif', '.svs', '.scn', '.bif']:
        return file_path
    
    needs_conversion, compression = check_tiff_compression(file_path)
    
    if not needs_conversion:
        return file_path
    
    compression_names = {
        5: 'LZW',
        6: 'Old JPEG',
        8: 'Deflate/ZIP',
        32773: 'PackBits'
    }
    comp_name = compression_names.get(compression, f'Type {compression}')
    
    if job:
        job.message = f"Converting {comp_name} compression to JPEG..."
        job.progress = 25
    
    logger.info(f"File uses {comp_name} compression - pre-processing with pyvips")
    
    try:
        converted_path = convert_to_jpeg_tiff(file_path, output_dir)
        logger.info(f"Pre-processing complete: {converted_path}")
        return converted_path
    except Exception as e:
        logger.error(f"Pre-processing failed: {e}")
        # Try to continue with original file anyway
        logger.info("Attempting to continue with original file...")
        return file_path


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    # Startup: ensure directories exist
    for subdir in ["incoming", "processing", "completed", "failed"]:
        Path(settings.watch_folder, subdir).mkdir(parents=True, exist_ok=True)
    
    print(f"🚀 Converter service started")
    print(f"   Orthanc URL: {settings.orthanc_url}")
    print(f"   Watch folder: {settings.watch_folder}")
    
    yield
    
    # Shutdown
    print("👋 Converter service shutting down")


app = FastAPI(
    title="DICOM WSI Converter",
    description="Converts proprietary WSI formats (iSyntax, NDPI, SVS) to DICOM",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Health & Status Endpoints
# =============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}

@app.get("/leica-pyramid/{study_id}")
async def get_leica_pyramid_info(study_id: str):
    """
    Check if a study contains Leica-style separate resolution files
    and return virtual pyramid information
    """
    try:
        # Query Orthanc for study info
        async with httpx.AsyncClient() as client:
            auth = httpx.BasicAuth("admin", "orthanc")
            
            # Get all series in the study
            study_response = await client.get(
                f"{settings.orthanc_url}/studies/{study_id}",
                auth=auth
            )
            study_response.raise_for_status()
            study_data = study_response.json()
            
            # Collect all instances across all series
            all_instances = []
            for series_id in study_data['Series']:
                series_response = await client.get(
                    f"{settings.orthanc_url}/series/{series_id}/instances",
                    auth=auth
                )
                series_response.raise_for_status()
                instances = series_response.json()
                
                for instance in instances:
                    # Get instance tags
                    tags_response = await client.get(
                        f"{settings.orthanc_url}/instances/{instance['ID']}/simplified-tags",
                        auth=auth
                    )
                    tags_response.raise_for_status()
                    tags = tags_response.json()
                    
                    # Check if it's a WSI file (SM modality)
                    if tags.get('Modality') == 'SM':
                        all_instances.append({
                            'id': instance['ID'],
                            'width': int(tags.get('Columns', 0)),
                            'height': int(tags.get('Rows', 0)),
                            'series_id': series_id
                        })
            
            # Sort by resolution (largest first)
            all_instances.sort(key=lambda x: x['width'] * x['height'], reverse=True)
            
            if len(all_instances) >= 2:  # Need at least 2 levels for a pyramid
                # Build virtual pyramid structure
                base_width = all_instances[0]['width']
                base_height = all_instances[0]['height']
                
                resolutions = []
                sizes = []
                instance_ids = []
                
                for inst in all_instances:
                    downsample = base_width / inst['width']
                    resolutions.append(downsample)
                    sizes.append([inst['width'], inst['height']])
                    instance_ids.append(inst['id'])
                
                pyramid_info = {
                    'ID': study_id,
                    'TotalWidth': base_width,
                    'TotalHeight': base_height,
                    'Resolutions': resolutions,
                    'Sizes': sizes,
                    'TilesSizes': [[256, 256]] * len(resolutions),
                    'TilesCount': [[int((w + 255) / 256), int((h + 255) / 256)] for w, h in sizes],
                    'BackgroundColor': '#ffffff',
                    'InstanceIDs': instance_ids,
                    'IsVirtualPyramid': True,
                    'Type': 'LeicaMultiFile'
                }
                
                logger.info(f"Created virtual Leica pyramid with {len(resolutions)} levels")
                return pyramid_info
            
        return {"error": "Not a Leica multi-file pyramid"}
        
    except Exception as e:
        logger.error(f"Error checking Leica pyramid: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/aggregate-leica")
async def aggregate_leica_studies():
    """Find and aggregate all Leica multi-file studies"""
    try:
        from leica_aggregator import aggregate_all_leica_studies
        
        # Run aggregation in background
        asyncio.create_task(aggregate_all_leica_studies())
        
        return {"status": "Leica aggregation started in background"}
        
    except Exception as e:
        logger.error(f"Error starting Leica aggregation: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/status")
async def service_status():
    """Get service status and Orthanc connectivity"""
    orthanc_status = "unknown"
    orthanc_version = None
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/system",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=5.0
            )
            if response.status_code == 200:
                orthanc_status = "connected"
                orthanc_version = response.json().get("Version")
    except Exception as e:
        orthanc_status = f"error: {str(e)}"
    
    return {
        "service": "converter",
        "status": "running",
        "orthanc": {
            "url": settings.orthanc_url,
            "status": orthanc_status,
            "version": orthanc_version
        },
        "active_jobs": len([j for j in conversion_jobs.values() if j.status == "processing"]),
        "total_jobs": len(conversion_jobs)
    }


@app.get("/system")
async def get_orthanc_system():
    """Proxy Orthanc system info - used by viewer for health check"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/system",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=10.0
            )
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")


@app.post("/instances")
async def upload_dicom_instance(request: Request):
    """Upload a DICOM instance directly to Orthanc"""
    try:
        content = await request.body()
        
        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.post(
                f"{settings.orthanc_url}/instances",
                content=content,
                headers={"Content-Type": "application/dicom"},
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            
            if response.status_code in [200, 201]:
                return response.json()
            else:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Orthanc error: {response.text}"
                )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Upload timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Direct DICOM Upload (proxy to Orthanc)
# =============================================================================

@app.post("/upload-dicom")
async def upload_dicom(file: UploadFile = File(...)):
    """Upload a DICOM file directly to Orthanc"""
    try:
        content = await file.read()
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{settings.orthanc_url}/instances",
                content=content,
                headers={"Content-Type": "application/dicom"},
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=300.0  # 5 minute timeout for large files
            )
            
            if response.status_code == 200:
                return response.json()
            else:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Orthanc error: {response.text}"
                )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Upload timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/series/{series_id}")
async def get_series(series_id: str):
    """Get series details from Orthanc"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/series/{series_id}",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=10.0
            )
            if response.status_code == 200:
                return response.json()
            raise HTTPException(status_code=response.status_code, detail="Series not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/instances/{instance_id}/simplified-tags")
async def get_instance_tags(instance_id: str):
    """Get simplified DICOM tags for an instance"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/instances/{instance_id}/simplified-tags",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=10.0
            )
            if response.status_code == 200:
                return response.json()
            raise HTTPException(status_code=response.status_code, detail="Instance not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# File Upload & Conversion
# =============================================================================

def detect_format(filename: str) -> str:
    """Detect WSI format from filename"""
    ext = Path(filename).suffix.lower()
    format_map = {
        ".ndpi": "hamamatsu",
        ".svs": "aperio",
        ".tif": "generic_tiff",
        ".tiff": "generic_tiff",
        ".isyntax": "philips",
        ".mrxs": "mirax",
        ".scn": "leica",
        ".bif": "ventana",
        ".vsi": "olympus",
        ".dcm": "dicom",
        ".zip": "zip_archive",  # Multi-file format in ZIP
    }
    return format_map.get(ext, "unknown")


def find_wsi_index_file(folder: Path) -> Optional[Path]:
    """
    Find the main WSI index file in a folder (for multi-file formats).
    Returns the path to the main file, or None if not found.
    """
    # Priority order for index files
    index_patterns = [
        "**/*.mrxs",   # 3DHISTECH MIRAX
        "**/*.vms",    # Hamamatsu VMS
        "**/*.vmu",    # Hamamatsu VMU
        "**/*.ets",    # Hamamatsu ETS (multi-file)
        "**/*.svslide",  # Aperio multi-file
    ]
    
    for pattern in index_patterns:
        matches = list(folder.glob(pattern))
        if matches:
            # Return the first match (should only be one)
            logger.info(f"Found WSI index file: {matches[0]}")
            return matches[0]
    
    return None


def get_multifile_format(index_file: Path) -> str:
    """Get the format name for a multi-file WSI index file"""
    ext = index_file.suffix.lower()
    format_map = {
        ".mrxs": "mirax",
        ".vms": "hamamatsu_vms",
        ".vmu": "hamamatsu_vmu",
        ".ets": "hamamatsu_ets",
        ".svslide": "aperio_multifile",
    }
    return format_map.get(ext, "unknown")


# Mapping of formats to manufacturer info
FORMAT_METADATA = {
    "hamamatsu": {
        "manufacturer": "Hamamatsu Photonics",
        "model": "NanoZoomer",
        "format_name": "NDPI",
    },
    "hamamatsu_vms": {
        "manufacturer": "Hamamatsu Photonics",
        "model": "NanoZoomer VMS",
        "format_name": "VMS",
    },
    "hamamatsu_vmu": {
        "manufacturer": "Hamamatsu Photonics",
        "model": "NanoZoomer VMU",
        "format_name": "VMU",
    },
    "hamamatsu_ets": {
        "manufacturer": "Hamamatsu Photonics",
        "model": "NanoZoomer ETS",
        "format_name": "ETS",
    },
    "aperio": {
        "manufacturer": "Leica Biosystems (Aperio)",
        "model": "Aperio Scanner",
        "format_name": "SVS",
    },
    "aperio_multifile": {
        "manufacturer": "Leica Biosystems (Aperio)",
        "model": "Aperio Scanner",
        "format_name": "SVSlide",
    },
    "philips": {
        "manufacturer": "Philips",
        "model": "IntelliSite Ultra Fast Scanner",
        "format_name": "iSyntax",
    },
    "leica": {
        "manufacturer": "Leica Biosystems",
        "model": "Leica Scanner",
        "format_name": "SCN",
    },
    "ventana": {
        "manufacturer": "Roche (Ventana)",
        "model": "Ventana Scanner",
        "format_name": "BIF",
    },
    "mirax": {
        "manufacturer": "3DHISTECH",
        "model": "Pannoramic Scanner",
        "format_name": "MRXS",
    },
    "olympus": {
        "manufacturer": "Olympus",
        "model": "VS Series",
        "format_name": "VSI",
    },
    "generic_tiff": {
        "manufacturer": "Unknown",
        "model": "Unknown",
        "format_name": "TIFF",
    },
    "zip_archive": {
        "manufacturer": "Unknown",
        "model": "Unknown",
        "format_name": "ZIP (multi-file)",
    },
}


def get_format_metadata(source_format: str) -> dict:
    """Get manufacturer metadata for a format"""
    return FORMAT_METADATA.get(source_format, {
        "manufacturer": "Unknown",
        "model": "Unknown", 
        "format_name": source_format.upper(),
    })


async def convert_isyntax_to_dicom(job_id: str, file_path: Path, output_dir: Path):
    """
    Convert Philips iSyntax file to DICOM using pyisyntax.
    Note: wsidicomizer does not support iSyntax directly, so we use pyisyntax
    to create a simple DICOM representation at a reduced resolution level.
    """
    job = conversion_jobs[job_id]
    
    try:
        from isyntax import ISyntax
        import numpy as np
        import pydicom
        from pydicom.uid import generate_uid
        import datetime
        
        job.message = "Opening iSyntax file..."
        job.progress = 15
        
        with ISyntax.open(str(file_path)) as isyntax:
            # Get image dimensions
            width, height = isyntax.dimensions
            num_levels = isyntax.level_count
            
            job.message = f"iSyntax: {width}x{height}, {num_levels} levels"
            job.progress = 25
            
            # Use a mid-resolution level for reasonable file size and quality
            level = min(3, num_levels - 1)  # Use level 3 or lowest available
            
            level_obj = isyntax.wsi.get_level(level)
            level_width = level_obj.width
            level_height = level_obj.height
            
            job.message = f"Reading level {level} ({level_width}x{level_height})..."
            job.progress = 35
            
            # Read the whole image at this resolution
            pixels = isyntax.read_region(0, 0, level_width, level_height, level=level)
            
            job.message = "Creating DICOM..."
            job.progress = 50
            
            # Create DICOM dataset
            ds = pydicom.Dataset()
            ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.77.1.6'  # VL Whole Slide Microscopy
            ds.SOPInstanceUID = generate_uid()
            ds.StudyInstanceUID = generate_uid()
            ds.SeriesInstanceUID = generate_uid()
            ds.PatientName = file_path.stem
            ds.PatientID = 'ISYNTAX-CONVERT'
            ds.StudyDate = datetime.datetime.now().strftime('%Y%m%d')
            ds.StudyTime = datetime.datetime.now().strftime('%H%M%S')
            ds.StudyDescription = f"Philips iSyntax (level {level} of {num_levels})"
            ds.SeriesDescription = f"Converted from iSyntax"
            ds.Modality = 'SM'
            ds.Manufacturer = 'Philips (converted via pyisyntax)'
            ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME']
            ds.SamplesPerPixel = 3
            ds.PhotometricInterpretation = 'RGB'
            ds.Rows = pixels.shape[0]
            ds.Columns = pixels.shape[1]
            ds.BitsAllocated = 8
            ds.BitsStored = 8
            ds.HighBit = 7
            ds.PixelRepresentation = 0
            ds.PlanarConfiguration = 0
            
            # Handle RGBA -> RGB if needed
            if pixels.shape[2] == 4:
                pixel_data = pixels[:, :, :3].tobytes()
            else:
                pixel_data = pixels.tobytes()
            ds.PixelData = pixel_data
            
            ds.file_meta = pydicom.Dataset()
            ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
            ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
            ds.file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
            
            output_file = output_dir / f"{file_path.stem}_level{level}.dcm"
            ds.save_as(str(output_file))
            
            job.message = f"iSyntax conversion complete ({level_width}x{level_height})"
            job.progress = 70
            
            return [output_file]
            
    except ImportError as e:
        raise Exception(f"pyisyntax not available: {e}")


async def convert_wsi_to_dicom(job_id: str, file_path: Path):
    """
    Convert WSI file to DICOM and upload to Orthanc
    
    This is the main conversion pipeline using wsidicomizer
    Supports both single-file formats (SVS, NDPI, etc.) and 
    multi-file formats via ZIP archives (MIRAX, VMS, etc.)
    """
    import zipfile
    
    job = conversion_jobs[job_id]
    job.status = "processing"
    job.message = "Starting conversion..."
    
    output_dir = Path(settings.watch_folder) / "processing" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Track extracted folder for cleanup
    extracted_dir = None
    actual_file_path = file_path
    original_filename = file_path.name
    
    try:
        # Detect format first
        source_format = detect_format(file_path.name)
        job.message = f"Detected format: {source_format}"
        job.progress = 10
        
        # Handle ZIP archives (multi-file formats like MIRAX)
        if source_format == "zip_archive":
            job.message = "Extracting ZIP archive..."
            job.progress = 15
            
            extracted_dir = Path(settings.watch_folder) / "processing" / f"{job_id}_extracted"
            extracted_dir.mkdir(parents=True, exist_ok=True)
            
            try:
                with zipfile.ZipFile(file_path, 'r') as zip_ref:
                    zip_ref.extractall(extracted_dir)
                logger.info(f"Extracted ZIP to {extracted_dir}")
                
                # List extracted contents for debugging
                extracted_files = list(extracted_dir.rglob("*"))
                logger.info(f"Extracted {len(extracted_files)} files/folders")
                
            except zipfile.BadZipFile:
                raise Exception("Invalid ZIP file")
            
            # Find the main WSI index file
            index_file = find_wsi_index_file(extracted_dir)
            
            if not index_file:
                raise Exception("No supported WSI index file found in ZIP archive. "
                              "Supported formats: MRXS, VMS, VMU, ETS, SVSlide")
            
            # Update paths and format
            actual_file_path = index_file
            source_format = get_multifile_format(index_file)
            original_filename = index_file.name
            
            job.message = f"Found {source_format.upper()} file: {index_file.name}"
            logger.info(f"Processing multi-file WSI: {source_format} from {index_file}")
        
        # Pre-process files with unsupported compression (LZW, Deflate, etc.)
        # This converts them to JPEG-compressed pyramid TIFF using pyvips
        job.progress = 18
        job.message = "Checking file compression..."
        actual_file_path = preprocess_for_conversion(actual_file_path, output_dir, job)
        
        # Use wsidicomizer for all supported formats (including iSyntax)
        from wsidicomizer import WsiDicomizer
        
        job.progress = 20
        job.message = f"Opening {source_format} file..."
        
        # Special check for iSyntax to ensure isyntax module is available
        if source_format == "philips":
            try:
                import isyntax
                logger.info("isyntax module available for iSyntax support")
            except ImportError:
                logger.warning("isyntax module not available, trying anyway...")
        
        # Get format metadata for proper manufacturer/model tagging
        format_meta = get_format_metadata(source_format)
        # Use original_filename from ZIP extraction if applicable, otherwise file_path.name
        if not original_filename or original_filename == file_path.name:
            original_filename = actual_file_path.name
        
        # Create metadata post-processor to add source tracking
        def metadata_post_processor(ds, wsi_metadata):
            """Add source format tracking to DICOM metadata"""
            # Set manufacturer info
            ds.Manufacturer = format_meta["manufacturer"]
            ds.ManufacturerModelName = format_meta["model"]
            ds.SoftwareVersions = ["DICOM Server Converter v1.0", f"Converted from {format_meta['format_name']}"]
            
            # Store original filename in InstitutionName (visible in metadata)
            ds.InstitutionName = f"Converted: {original_filename}"
            
            # Update series description to include source format
            if hasattr(ds, 'SeriesDescription'):
                ds.SeriesDescription = f"{ds.SeriesDescription} [Source: {format_meta['format_name']}]"
            else:
                ds.SeriesDescription = f"Converted from {format_meta['format_name']}"
            
            return ds
        
        # Convert to DICOM using wsidicomizer
        # wsidicomizer supports: SVS, NDPI, iSyntax, MRXS, SCN, CZI, TIFF, and more
        job.message = "Converting to DICOM WSI pyramid (this may take a while)..."
        job.progress = 30
        
        logger.info(f"Converting {format_meta['format_name']} from {format_meta['manufacturer']}")
        
        # Special handling for iSyntax files - try wsidicomizer first (more stable)
        if source_format == "philips":
            logger.info("Converting iSyntax using wsidicomizer...")
            try:
                with WsiDicomizer.open(str(actual_file_path), metadata_post_processor=metadata_post_processor) as wsi:
                    logger.info(f"Opened iSyntax: {wsi.size.width}x{wsi.size.height}")
                    num_levels = len(wsi.levels) if hasattr(wsi, 'levels') else 1
                    logger.info(f"Source has {num_levels} pyramid levels")
                    job.message = f"Generating DICOM pyramid ({wsi.size.width}x{wsi.size.height})..."
                    job.progress = 40
                    # add_missing_levels=True generates downsampled pyramid levels
                    wsi.save(str(output_dir), add_missing_levels=True)
                    generated_files = list(output_dir.glob("*.dcm"))
                    logger.info(f"wsidicomizer generated {len(generated_files)} DICOM files (with pyramid)")
            except Exception as e:
                logger.warning(f"wsidicomizer failed for iSyntax: {e}")
                # Fall back to simple single-level conversion
                logger.info("Falling back to simple iSyntax conversion...")
                try:
                    dicom_files = await convert_isyntax_to_dicom(job_id, actual_file_path, output_dir)
                    logger.info(f"Simple converter generated {len(dicom_files)} DICOM files")
                except Exception as e2:
                    logger.error(f"All iSyntax converters failed: {e2}")
                    raise Exception(f"iSyntax conversion failed: {e2}")
        else:
            # Use wsidicomizer for other formats (including multi-file from ZIP)
            try:
                with WsiDicomizer.open(str(actual_file_path), metadata_post_processor=metadata_post_processor) as wsi:
                    # Log pyramid information
                    logger.info(f"Opened WSI: {wsi.size.width}x{wsi.size.height}")
                    num_levels = len(wsi.levels) if hasattr(wsi, 'levels') else 1
                    logger.info(f"Source has {num_levels} pyramid levels")
                    
                    job.message = f"Generating DICOM pyramid ({wsi.size.width}x{wsi.size.height})..."
                    job.progress = 40
                    
                    # add_missing_levels=True ensures full pyramid is generated
                    wsi.save(str(output_dir), add_missing_levels=True)
                    
                    # Log generated files
                    generated_files = list(output_dir.glob("*.dcm"))
                    logger.info(f"Generated {len(generated_files)} DICOM files (with pyramid)")
                    
            except Exception as e:
                error_msg = str(e).lower()
                # Check if this is a compression-related error
                if 'compression' in error_msg or 'unsupported' in error_msg or 'decode' in error_msg:
                    logger.warning(f"wsidicomizer failed with compression error: {e}")
                    logger.info("Attempting pyvips fallback conversion...")
                    
                    job.message = "Trying alternative conversion method..."
                    job.progress = 25
                    
                    try:
                        # Force conversion through pyvips
                        converted_path = convert_to_jpeg_tiff(file_path, output_dir)
                        
                        job.message = "Re-attempting DICOM conversion..."
                        job.progress = 35
                        
                        with WsiDicomizer.open(str(converted_path), metadata_post_processor=metadata_post_processor) as wsi:
                            logger.info(f"Opened converted WSI: {wsi.size.width}x{wsi.size.height}")
                            num_levels = len(wsi.levels) if hasattr(wsi, 'levels') else 1
                            logger.info(f"Source has {num_levels} pyramid levels")
                            
                            job.message = f"Generating DICOM pyramid ({wsi.size.width}x{wsi.size.height})..."
                            job.progress = 45
                            
                            wsi.save(str(output_dir), add_missing_levels=True)
                            
                            generated_files = list(output_dir.glob("*.dcm"))
                            logger.info(f"Fallback generated {len(generated_files)} DICOM files")
                    except Exception as fallback_error:
                        logger.error(f"Fallback conversion also failed: {fallback_error}")
                        raise Exception(f"Conversion failed: {e}. Fallback also failed: {fallback_error}")
                else:
                    logger.error(f"wsidicomizer failed: {str(e)}")
                    raise
        
        dicom_files = list(output_dir.glob("*.dcm"))
        job.message = f"Created {len(dicom_files)} DICOM files"
        
        job.progress = 70
        job.message = "Uploading to Orthanc..."
        
        if not dicom_files:
            raise Exception("No DICOM files generated")
        
        study_uid = None
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            for dcm_file in dicom_files:
                with open(dcm_file, "rb") as f:
                    dicom_data = f.read()
                
                # Upload via STOW-RS
                response = await client.post(
                    f"{settings.orthanc_url}/dicom-web/studies",
                    content=dicom_data,
                    headers={
                        "Content-Type": "application/dicom",
                        "Accept": "application/dicom+json"
                    },
                    auth=(settings.orthanc_username, settings.orthanc_password)
                )
                
                if response.status_code not in [200, 201]:
                    # Fallback: use Orthanc REST API
                    response = await client.post(
                        f"{settings.orthanc_url}/instances",
                        content=dicom_data,
                        headers={"Content-Type": "application/dicom"},
                        auth=(settings.orthanc_username, settings.orthanc_password)
                    )
                
                if response.status_code in [200, 201]:
                    result = response.json()
                    if isinstance(result, dict) and "ParentStudy" in result:
                        study_uid = result.get("ParentStudy")
        
        job.progress = 100
        job.status = "completed"
        job.study_uid = study_uid
        job.message = f"Conversion complete. Study: {study_uid}"
        job.completed_at = datetime.utcnow()
        
        # Move original to completed
        completed_path = Path(settings.watch_folder) / "completed" / file_path.name
        shutil.move(str(file_path), str(completed_path))
        
        # Clean up processing directory and extracted folder
        shutil.rmtree(output_dir, ignore_errors=True)
        if extracted_dir and extracted_dir.exists():
            shutil.rmtree(extracted_dir, ignore_errors=True)
        
    except Exception as e:
        job.status = "failed"
        job.message = f"Conversion failed: {str(e)}"
        job.completed_at = datetime.utcnow()
        
        # Move to failed
        failed_path = Path(settings.watch_folder) / "failed" / file_path.name
        if file_path.exists():
            shutil.move(str(file_path), str(failed_path))
        
        # Clean up processing and extracted directories
        shutil.rmtree(output_dir, ignore_errors=True)
        if extracted_dir and extracted_dir.exists():
            shutil.rmtree(extracted_dir, ignore_errors=True)
        
        raise


@app.post("/upload", response_model=UploadResponse)
async def upload_wsi(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    """
    Upload a WSI file for conversion to DICOM
    
    Supported formats:
    - Single-file: NDPI, SVS, iSyntax, SCN, TIFF, BIF
    - Multi-file (via ZIP): MRXS, VMS, VMU
    
    For multi-file formats like MIRAX, upload the entire folder as a ZIP archive.
    The ZIP should contain the index file (.mrxs) and all associated data files.
    """
    # Validate format
    source_format = detect_format(file.filename)
    if source_format == "unknown":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {Path(file.filename).suffix}. "
                   f"Supported: .ndpi, .svs, .isyntax, .scn, .tiff, .bif, .mrxs, .zip"
        )
    
    if source_format == "dicom":
        raise HTTPException(
            status_code=400,
            detail="File is already DICOM. Upload directly to Orthanc."
        )
    
    # Special message for multi-file formats uploaded as single file
    if source_format == "mirax":
        raise HTTPException(
            status_code=400,
            detail="MIRAX (.mrxs) is a multi-file format. Please upload the entire folder as a ZIP archive. "
                   "The ZIP should contain the .mrxs file and all Data*.dat files."
        )
    
    # Generate job ID
    job_id = str(uuid.uuid4())[:8]
    
    # Save uploaded file
    incoming_dir = Path(settings.watch_folder) / "incoming"
    file_path = incoming_dir / f"{job_id}_{file.filename}"
    
    try:
        with open(file_path, "wb") as buffer:
            # Stream file to disk
            while chunk := await file.read(1024 * 1024):  # 1MB chunks
                buffer.write(chunk)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
    
    # Create job record
    job = ConversionJob(
        job_id=job_id,
        filename=file.filename,
        status="pending",
        message=f"Queued for conversion (format: {source_format})",
        created_at=datetime.utcnow()
    )
    conversion_jobs[job_id] = job
    
    # Start conversion in background
    background_tasks.add_task(convert_wsi_to_dicom, job_id, file_path)
    
    return UploadResponse(
        job_id=job_id,
        message=f"File queued for conversion",
        status="pending"
    )


@app.get("/jobs")
async def list_jobs():
    """List all conversion jobs"""
    return {
        "jobs": [job.model_dump() for job in conversion_jobs.values()],
        "total": len(conversion_jobs)
    }


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Get status of a specific conversion job"""
    if job_id not in conversion_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return conversion_jobs[job_id].model_dump()


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    """Delete a completed/failed job from history"""
    if job_id not in conversion_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = conversion_jobs[job_id]
    if job.status == "processing":
        raise HTTPException(status_code=400, detail="Cannot delete job in progress")
    
    del conversion_jobs[job_id]
    return {"message": "Job deleted"}


# =============================================================================
# Orthanc Proxy Endpoints
# =============================================================================

@app.get("/studies")
async def list_studies():
    """List all studies in Orthanc - returns array of study IDs"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/studies",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=30.0
            )
            response.raise_for_status()
            # Return the array of study IDs directly (same format as Orthanc)
            return response.json()
            
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")


@app.get("/studies/{study_id}")
async def get_study(study_id: str):
    """Get study details from Orthanc"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/studies/{study_id}",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=30.0
            )
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")


@app.get("/studies/{study_id}/wsi-metadata")
async def get_wsi_metadata(study_id: str):
    """
    Get WSI pyramid metadata for OpenSeadragon tile source
    Returns tile dimensions, pyramid levels, and instance mappings
    """
    try:
        async with httpx.AsyncClient() as client:
            # Get study details
            study_response = await client.get(
                f"{settings.orthanc_url}/studies/{study_id}",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=30.0
            )
            study_response.raise_for_status()
            study = study_response.json()
            
            # Get all instances in the study
            instances = []
            for series_id in study.get("Series", []):
                series_response = await client.get(
                    f"{settings.orthanc_url}/series/{series_id}",
                    auth=(settings.orthanc_username, settings.orthanc_password)
                )
                if series_response.status_code == 200:
                    series = series_response.json()
                    for instance_id in series.get("Instances", []):
                        # Get instance tags
                        tags_response = await client.get(
                            f"{settings.orthanc_url}/instances/{instance_id}/simplified-tags",
                            auth=(settings.orthanc_username, settings.orthanc_password)
                        )
                        if tags_response.status_code == 200:
                            tags = tags_response.json()
                            instances.append({
                                "id": instance_id,
                                "width": int(tags.get("TotalPixelMatrixColumns", 0) or 0),
                                "height": int(tags.get("TotalPixelMatrixRows", 0) or 0),
                                "tileWidth": int(tags.get("Columns", 256) or 256),
                                "tileHeight": int(tags.get("Rows", 256) or 256),
                                "numberOfFrames": int(tags.get("NumberOfFrames", 1) or 1),
                                "imageType": tags.get("ImageType", ""),
                            })
            
            # Find the main WSI instance (highest resolution with multiple frames)
            wsi_instances = [i for i in instances if i["numberOfFrames"] > 1 and i["width"] > 0]
            wsi_instances.sort(key=lambda x: x["width"], reverse=True)
            
            if not wsi_instances:
                raise HTTPException(status_code=404, detail="No WSI instances found in study")
            
            main_instance = wsi_instances[0]
            
            # Calculate tiles per row/column
            tiles_x = (main_instance["width"] + main_instance["tileWidth"] - 1) // main_instance["tileWidth"]
            tiles_y = (main_instance["height"] + main_instance["tileHeight"] - 1) // main_instance["tileHeight"]
            
            return {
                "studyId": study_id,
                "instanceId": main_instance["id"],
                "width": main_instance["width"],
                "height": main_instance["height"],
                "tileWidth": main_instance["tileWidth"],
                "tileHeight": main_instance["tileHeight"],
                "tilesX": tiles_x,
                "tilesY": tiles_y,
                "numberOfFrames": main_instance["numberOfFrames"],
                "levels": [
                    {
                        "instanceId": inst["id"],
                        "width": inst["width"],
                        "height": inst["height"],
                        "numberOfFrames": inst["numberOfFrames"]
                    }
                    for inst in wsi_instances
                ]
            }
            
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")


from fastapi.responses import Response

@app.get("/instances/{instance_id}/frames/{frame_number}")
async def get_frame(instance_id: str, frame_number: int):
    """
    Proxy frame requests to Orthanc
    Returns JPEG image of the specified frame
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.orthanc_url}/instances/{instance_id}/frames/{frame_number}/preview",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=30.0
            )
            response.raise_for_status()
            
            return Response(
                content=response.content,
                media_type="image/jpeg",
                headers={
                    "Cache-Control": "public, max-age=31536000",
                    "Access-Control-Allow-Origin": "*"
                }
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")


# =============================================================================
# ICC Profile Extraction
# =============================================================================

@app.get("/studies/{study_id}/icc-profile")
async def get_icc_profile(study_id: str, include_transform: bool = False):
    """
    Extract ICC color profile from a DICOM WSI study.
    Returns the ICC profile metadata and optionally the color transformation data.
    
    Query params:
        include_transform: If true, includes parsed color transformation matrices for WebGL
    """
    import pydicom
    import io
    import base64
    from icc_parser import parse_icc_profile
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Get study info
            study_response = await client.get(
                f"{settings.orthanc_url}/studies/{study_id}",
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            study_response.raise_for_status()
            study = study_response.json()
            
            if not study.get('Series'):
                raise HTTPException(status_code=404, detail="No series in study")
            
            # Get first series
            series_id = study['Series'][0]
            series_response = await client.get(
                f"{settings.orthanc_url}/series/{series_id}",
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            series_response.raise_for_status()
            series = series_response.json()
            
            if not series.get('Instances'):
                raise HTTPException(status_code=404, detail="No instances in series")
            
            # Get first instance DICOM file
            instance_id = series['Instances'][0]
            file_response = await client.get(
                f"{settings.orthanc_url}/instances/{instance_id}/file",
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            file_response.raise_for_status()
            
            # Parse DICOM
            ds = pydicom.dcmread(io.BytesIO(file_response.content), force=True)
            
            # Look for ICC profile
            icc_data = None
            icc_location = None
            
            # Check OpticalPathSequence first (most common for WSI)
            if hasattr(ds, 'OpticalPathSequence'):
                for i, item in enumerate(ds.OpticalPathSequence):
                    icc = getattr(item, 'ICCProfile', None)
                    if icc and len(icc) > 0:
                        icc_data = bytes(icc)
                        icc_location = f"OpticalPathSequence[{i}]"
                        break
            
            # Check top-level ICCProfile
            if not icc_data and hasattr(ds, 'ICCProfile') and ds.ICCProfile:
                icc_data = bytes(ds.ICCProfile)
                icc_location = "TopLevel"
            
            if not icc_data:
                return {
                    "study_id": study_id,
                    "has_icc": False,
                    "message": "No ICC profile found in DICOM"
                }
            
            # Parse ICC profile header
            profile_info = {}
            if len(icc_data) >= 128:
                profile_info['size'] = int.from_bytes(icc_data[0:4], 'big')
                profile_info['preferred_cmm'] = icc_data[4:8].decode('ascii', errors='replace').strip()
                profile_info['version'] = f"{icc_data[8]}.{icc_data[9]}.{icc_data[10]}"
                profile_info['profile_class'] = icc_data[12:16].decode('ascii', errors='replace').strip()
                profile_info['color_space'] = icc_data[16:20].decode('ascii', errors='replace').strip()
                profile_info['pcs'] = icc_data[20:24].decode('ascii', errors='replace').strip()
            
            result = {
                "study_id": study_id,
                "has_icc": True,
                "location": icc_location,
                "size_bytes": len(icc_data),
                "profile_info": profile_info,
            }
            
            # Include color transformation data if requested
            if include_transform:
                try:
                    parsed = parse_icc_profile(icc_data)
                    result["color_transform"] = parsed
                except Exception as e:
                    logger.warning(f"Failed to parse ICC profile: {e}")
                    result["color_transform"] = None
            
            return result
            
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")
    except Exception as e:
        logger.error(f"Error extracting ICC profile: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/studies/{study_id}/icc-profile/raw")
async def get_icc_profile_raw(study_id: str):
    """
    Get the raw ICC profile binary data.
    Can be used directly by color management systems.
    """
    import pydicom
    import io
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Get study -> series -> instance
            study_response = await client.get(
                f"{settings.orthanc_url}/studies/{study_id}",
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            study_response.raise_for_status()
            study = study_response.json()
            
            if not study.get('Series'):
                raise HTTPException(status_code=404, detail="No series in study")
            
            series_id = study['Series'][0]
            series_response = await client.get(
                f"{settings.orthanc_url}/series/{series_id}",
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            series_response.raise_for_status()
            series = series_response.json()
            
            if not series.get('Instances'):
                raise HTTPException(status_code=404, detail="No instances in series")
            
            instance_id = series['Instances'][0]
            file_response = await client.get(
                f"{settings.orthanc_url}/instances/{instance_id}/file",
                auth=(settings.orthanc_username, settings.orthanc_password)
            )
            file_response.raise_for_status()
            
            ds = pydicom.dcmread(io.BytesIO(file_response.content), force=True)
            
            # Extract ICC
            icc_data = None
            if hasattr(ds, 'OpticalPathSequence'):
                for item in ds.OpticalPathSequence:
                    icc = getattr(item, 'ICCProfile', None)
                    if icc and len(icc) > 0:
                        icc_data = bytes(icc)
                        break
            
            if not icc_data and hasattr(ds, 'ICCProfile') and ds.ICCProfile:
                icc_data = bytes(ds.ICCProfile)
            
            if not icc_data:
                raise HTTPException(status_code=404, detail="No ICC profile in study")
            
            return Response(
                content=icc_data,
                media_type="application/vnd.iccprofile",
                headers={
                    "Content-Disposition": f"attachment; filename={study_id}.icc",
                    "Cache-Control": "public, max-age=86400"
                }
            )
            
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Orthanc error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

