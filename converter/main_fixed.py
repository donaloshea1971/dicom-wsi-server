"""
Fixed converter with proper multi-resolution pyramid generation
"""
import os
import uuid
import shutil
import asyncio
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

import httpx
import redis.asyncio as redis
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# Configuration
# =============================================================================

class Settings(BaseSettings):
    orthanc_url: str = "http://orthanc:8042"
    orthanc_username: str = "admin"
    orthanc_password: str = "orthanc"
    redis_url: str = "redis://redis:6379"
    watch_folder: str = "/uploads"
    max_file_size: int = 5 * 1024 * 1024 * 1024  # 5GB

    class Config:
        env_file = ".env"


settings = Settings()

# =============================================================================
# Models
# =============================================================================

class ConversionJob(BaseModel):
    job_id: str
    filename: str
    status: str = "pending"  # pending, processing, completed, failed
    message: str = ""
    progress: int = 0
    study_uid: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None


class UploadResponse(BaseModel):
    job_id: str
    message: str
    status: str


# =============================================================================
# Application Setup
# =============================================================================

app = FastAPI(title="DICOM WSI Converter", version="2.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job storage (consider Redis for production)
conversion_jobs: Dict[str, ConversionJob] = {}

# Create required directories
for folder in ["incoming", "processing", "completed", "failed"]:
    Path(settings.watch_folder) / folder).mkdir(parents=True, exist_ok=True)


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
        ".dcx": "generic_tiff",  # DCX multiresolution TIFF
        ".isyntax": "philips",
        ".mrxs": "mirax",
        ".scn": "leica",
        ".bif": "ventana",
        ".vsi": "olympus",
        ".dcm": "dicom",
    }
    return format_map.get(ext, "unknown")


async def convert_wsi_to_dicom(job_id: str, file_path: Path):
    """
    Convert WSI file to DICOM with proper multi-resolution pyramid
    """
    job = conversion_jobs[job_id]
    job.status = "processing"
    job.message = "Starting conversion..."
    
    output_dir = Path(settings.watch_folder) / "processing" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # Detect format
        source_format = detect_format(file_path.name)
        job.message = f"Detected format: {source_format}"
        job.progress = 10
        
        logger.info(f"Converting {source_format} file: {file_path}")
        
        # Import wsidicomizer
        from wsidicomizer import WsiDicomizer
        from wsidicomizer.config import WsiDicomizerConfig
        
        job.progress = 20
        job.message = f"Opening {source_format} file..."
        
        # Configure wsidicomizer for optimal pyramid generation
        config = WsiDicomizerConfig(
            # Enable all pyramid levels
            include_levels=None,  # None means include all levels
            # Set tile size for optimal performance
            tile_size=(256, 256),
            # Enable compression for smaller files
            compression='jpeg',
            quality=90,
            # Generate proper WSI metadata
            include_label=True,
            include_overview=True,
            # Use threads for faster conversion
            workers=4
        )
        
        job.message = "Converting to DICOM WSI pyramid..."
        job.progress = 30
        
        # Special handling for iSyntax files
        if source_format == "philips":
            # Ensure pyisyntax is available for wsidicomizer
            try:
                import pyisyntax
                logger.info("pyisyntax available for iSyntax support")
            except ImportError:
                logger.warning("pyisyntax not available, wsidicomizer may fail")
        
        # Convert using wsidicomizer with configuration
        with WsiDicomizer.open(str(file_path), config=config) as wsi:
            # Log pyramid information
            logger.info(f"Image size: {wsi.size.width}x{wsi.size.height}")
            logger.info(f"Number of levels: {len(wsi.levels)}")
            for i, level in enumerate(wsi.levels):
                logger.info(f"  Level {i}: {level.size.width}x{level.size.height}")
            
            job.message = f"Generating pyramid ({wsi.size.width}x{wsi.size.height}, {len(wsi.levels)} levels)..."
            job.progress = 40
            
            # Save with progress callback
            def progress_callback(current, total):
                progress_pct = int(40 + (current / total) * 30)
                job.progress = progress_pct
                job.message = f"Generating DICOM files... ({current}/{total})"
            
            wsi.save(str(output_dir), progress_callback=progress_callback)
        
        dicom_files = list(output_dir.glob("*.dcm"))
        logger.info(f"Generated {len(dicom_files)} DICOM files")
        job.message = f"Created {len(dicom_files)} DICOM files"
        
        job.progress = 70
        job.message = "Uploading to Orthanc..."
        
        if not dicom_files:
            raise Exception("No DICOM files generated")
        
        # Group files by series for better organization
        series_files = {}
        for dcm_file in dicom_files:
            # Extract series info from filename if possible
            # wsidicomizer typically names files as: seriesUID_instanceNumber.dcm
            series_key = dcm_file.stem.split('_')[0] if '_' in dcm_file.stem else 'default'
            if series_key not in series_files:
                series_files[series_key] = []
            series_files[series_key].append(dcm_file)
        
        logger.info(f"Found {len(series_files)} series to upload")
        
        study_uid = None
        uploaded_count = 0
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            for series_key, files in series_files.items():
                logger.info(f"Uploading series {series_key} with {len(files)} files")
                
                for dcm_file in files:
                    with open(dcm_file, "rb") as f:
                        dicom_data = f.read()
                    
                    # Try STOW-RS first (DICOMweb)
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
                        # Fallback to REST API
                        response = await client.post(
                            f"{settings.orthanc_url}/instances",
                            content=dicom_data,
                            headers={"Content-Type": "application/dicom"},
                            auth=(settings.orthanc_username, settings.orthanc_password)
                        )
                    
                    if response.status_code in [200, 201]:
                        uploaded_count += 1
                        result = response.json()
                        if isinstance(result, dict) and "ParentStudy" in result:
                            study_uid = result.get("ParentStudy")
                        
                        # Update progress
                        progress = 70 + int((uploaded_count / len(dicom_files)) * 30)
                        job.progress = progress
                        job.message = f"Uploaded {uploaded_count}/{len(dicom_files)} files"
                    else:
                        logger.error(f"Failed to upload {dcm_file.name}: {response.status_code}")
        
        if uploaded_count == 0:
            raise Exception("Failed to upload any DICOM files")
        
        job.progress = 100
        job.status = "completed"
        job.study_uid = study_uid
        job.message = f"Successfully converted and uploaded {uploaded_count} files. Study: {study_uid}"
        job.completed_at = datetime.utcnow()
        
        logger.info(f"Conversion completed: {job.message}")
        
        # Move original to completed
        completed_path = Path(settings.watch_folder) / "completed" / file_path.name
        completed_path.parent.mkdir(exist_ok=True)
        shutil.move(str(file_path), str(completed_path))
        
        # Clean up processing directory
        shutil.rmtree(output_dir, ignore_errors=True)
        
    except Exception as e:
        logger.error(f"Conversion failed: {str(e)}", exc_info=True)
        job.status = "failed"
        job.message = f"Conversion failed: {str(e)}"
        job.completed_at = datetime.utcnow()
        
        # Move to failed
        failed_path = Path(settings.watch_folder) / "failed" / file_path.name
        failed_path.parent.mkdir(exist_ok=True)
        if file_path.exists():
            shutil.move(str(file_path), str(failed_path))
        
        # Clean up
        shutil.rmtree(output_dir, ignore_errors=True)
        
        raise


@app.post("/upload", response_model=UploadResponse)
async def upload_wsi(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    """
    Upload a WSI file for conversion to DICOM
    
    Supported formats: NDPI, SVS, iSyntax, MRXS, SCN, TIFF, BIF
    """
    # Validate format
    source_format = detect_format(file.filename)
    if source_format == "unknown":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {Path(file.filename).suffix}"
        )
    
    if source_format == "dicom":
        raise HTTPException(
            status_code=400,
            detail="File is already DICOM. Upload directly to Orthanc."
        )
    
    # Generate job ID
    job_id = str(uuid.uuid4())[:8]
    
    # Save uploaded file
    incoming_dir = Path(settings.watch_folder) / "incoming"
    file_path = incoming_dir / f"{job_id}_{file.filename}"
    
    try:
        with open(file_path, "wb") as buffer:
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
        "jobs": list(conversion_jobs.values()),
        "total": len(conversion_jobs)
    }


@app.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    """Get status of a specific conversion job"""
    if job_id not in conversion_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return conversion_jobs[job_id]


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    """Delete a job record"""
    if job_id not in conversion_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    del conversion_jobs[job_id]
    return {"message": "Job deleted"}


@app.get("/formats")
async def list_supported_formats():
    """List supported WSI formats"""
    return {
        "formats": [
            {"extension": ".ndpi", "name": "Hamamatsu NDPI", "vendor": "Hamamatsu"},
            {"extension": ".svs", "name": "Aperio SVS", "vendor": "Leica/Aperio"},
            {"extension": ".isyntax", "name": "Philips iSyntax", "vendor": "Philips"},
            {"extension": ".mrxs", "name": "MIRAX", "vendor": "3DHISTECH"},
            {"extension": ".scn", "name": "Leica SCN", "vendor": "Leica"},
            {"extension": ".bif", "name": "Ventana BIF", "vendor": "Ventana/Roche"},
            {"extension": ".tif", "name": "Generic TIFF", "vendor": "Various"},
            {"extension": ".tiff", "name": "Generic TIFF", "vendor": "Various"},
            {"extension": ".vsi", "name": "Olympus VSI", "vendor": "Olympus"},
        ]
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "jobs_count": len(conversion_jobs),
        "orthanc_url": settings.orthanc_url
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
