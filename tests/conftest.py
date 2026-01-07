"""
Common test fixtures for DICOM WSI Server test suite.
"""

import os
import sys
import asyncio
from pathlib import Path
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
from typing import AsyncGenerator, Generator

import pytest
from httpx import AsyncClient

# Add converter module to path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))


# =============================================================================
# Async Event Loop Fixture
# =============================================================================

@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


# =============================================================================
# Environment Variable Fixtures
# =============================================================================

@pytest.fixture(autouse=True)
def mock_env_vars(monkeypatch):
    """Set up test environment variables."""
    env_vars = {
        "AUTH0_DOMAIN": "test.auth0.com",
        "AUTH0_AUDIENCE": "https://test-api.example.com",
        "DATABASE_URL": "postgresql://test:test@localhost:5432/test",
        "BREVO_API_KEY": "test-api-key-123",
        "SMTP_FROM": "test@example.com",
        "SMTP_FROM_NAME": "Test Service",
        "APP_URL": "https://test.example.com",
        "ORTHANC_URL": "http://localhost:8042",
        "ORTHANC_USERNAME": "admin",
        "ORTHANC_PASSWORD": "orthanc",
        "REDIS_URL": "redis://localhost:6379",
        "WATCH_FOLDER": "/tmp/test_uploads",
    }
    for key, value in env_vars.items():
        monkeypatch.setenv(key, value)
    return env_vars


# =============================================================================
# Database Mock Fixtures
# =============================================================================

@pytest.fixture
def mock_db_pool():
    """Create a mock database connection pool."""
    pool = AsyncMock()
    
    # Mock connection context manager
    conn = AsyncMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
    
    return pool, conn


@pytest.fixture
def mock_db_connection():
    """Create a mock database connection."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)
    conn.fetch = AsyncMock(return_value=[])
    conn.execute = AsyncMock(return_value="UPDATE 1")
    return conn


# =============================================================================
# User Fixtures
# =============================================================================

@pytest.fixture
def sample_user():
    """Create a sample authenticated user."""
    return {
        "id": 1,
        "auth0_id": "auth0|123456789",
        "email": "testuser@example.com",
        "name": "Test User",
        "picture": "https://example.com/avatar.png",
        "role": "user",
    }


@pytest.fixture
def sample_admin_user():
    """Create a sample admin user."""
    return {
        "id": 2,
        "auth0_id": "auth0|admin123",
        "email": "admin@example.com",
        "name": "Admin User",
        "picture": "https://example.com/admin-avatar.png",
        "role": "admin",
    }


@pytest.fixture
def sample_token_payload():
    """Create a sample JWT token payload."""
    return {
        "sub": "auth0|123456789",
        "email": "testuser@example.com",
        "name": "Test User",
        "picture": "https://example.com/avatar.png",
    }


# =============================================================================
# JWKS Mock Fixture
# =============================================================================

@pytest.fixture
def mock_jwks():
    """Create mock JWKS (JSON Web Key Set) for token verification."""
    return {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "n": "test-n-value",
                "e": "AQAB",
                "kid": "test-key-id",
                "alg": "RS256",
            }
        ]
    }


# =============================================================================
# HTTP Client Fixtures
# =============================================================================

@pytest.fixture
def mock_httpx_client():
    """Create a mock httpx async client."""
    client = AsyncMock()
    client.get = AsyncMock()
    client.post = AsyncMock()
    client.put = AsyncMock()
    client.delete = AsyncMock()
    return client


# =============================================================================
# Slide/Study Fixtures
# =============================================================================

@pytest.fixture
def sample_study_id():
    """Return a sample Orthanc study ID."""
    return "12345678-abcd-efgh-ijkl-mnopqrstuvwx"


@pytest.fixture
def sample_slide():
    """Create a sample slide record."""
    return {
        "id": 1,
        "orthanc_study_id": "12345678-abcd-efgh-ijkl-mnopqrstuvwx",
        "owner_id": 1,
        "display_name": "Test Slide",
        "stain": "H&E",
        "original_filename": "test_slide.svs",
        "source_format": "SVS",
        "scanner_manufacturer": "Aperio",
        "width": 50000,
        "height": 40000,
        "magnification": "40x",
        "case_id": None,
        "block_id": None,
        "patient_id": None,
        "is_sample": False,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }


@pytest.fixture
def sample_case():
    """Create a sample case record."""
    return {
        "id": 1,
        "owner_id": 1,
        "accession_number": "ACC-2024-001",
        "case_type": "surgical",
        "specimen_type": "breast",
        "patient_id": 1,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }


@pytest.fixture
def sample_patient():
    """Create a sample patient record."""
    return {
        "id": 1,
        "owner_id": 1,
        "name": "Jane Doe",
        "mrn": "MRN-12345",
        "dob": "1980-05-15",
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }


# =============================================================================
# ICC Profile Fixtures
# =============================================================================

@pytest.fixture
def sample_icc_header():
    """Create a sample ICC profile header (128 bytes)."""
    import struct
    
    header = bytearray(128)
    
    # Profile size (4 bytes)
    struct.pack_into(">I", header, 0, 1000)
    
    # CMM Type (4 bytes)
    header[4:8] = b"appl"
    
    # Version (4 bytes) - 4.3.0
    header[8] = 4
    header[9] = 3
    header[10] = 0
    header[11] = 0
    
    # Profile class (4 bytes)
    header[12:16] = b"mntr"  # Monitor
    
    # Color space (4 bytes)
    header[16:20] = b"RGB "
    
    # PCS (4 bytes)
    header[20:24] = b"XYZ "
    
    # Rendering intent (4 bytes)
    struct.pack_into(">I", header, 64, 0)
    
    # PCS illuminant XYZ (D50)
    struct.pack_into(">I", header, 68, int(0.9642 * 65536))
    struct.pack_into(">I", header, 72, int(1.0000 * 65536))
    struct.pack_into(">I", header, 76, int(0.8249 * 65536))
    
    return bytes(header)


@pytest.fixture
def minimal_icc_profile(sample_icc_header):
    """Create a minimal valid ICC profile."""
    import struct
    
    # Tag table (tag count + tags)
    tag_count = struct.pack(">I", 0)  # 0 tags for minimal profile
    
    return sample_icc_header + tag_count


# =============================================================================
# File System Fixtures
# =============================================================================

@pytest.fixture
def temp_watch_folder(tmp_path):
    """Create a temporary watch folder structure."""
    incoming = tmp_path / "incoming"
    processing = tmp_path / "processing"
    completed = tmp_path / "completed"
    failed = tmp_path / "failed"
    
    for folder in [incoming, processing, completed, failed]:
        folder.mkdir()
    
    return {
        "root": tmp_path,
        "incoming": incoming,
        "processing": processing,
        "completed": completed,
        "failed": failed,
    }


@pytest.fixture
def sample_wsi_file(temp_watch_folder):
    """Create a sample WSI file for testing."""
    file_path = temp_watch_folder["incoming"] / "test_slide.svs"
    file_path.write_bytes(b"FAKE SVS CONTENT")
    return file_path


# =============================================================================
# Conversion Job Fixtures
# =============================================================================

@pytest.fixture
def sample_job():
    """Create a sample conversion job."""
    return {
        "job_id": "job-123-abc",
        "filename": "test_slide.svs",
        "status": "pending",
        "progress": 0,
        "message": "",
        "study_uid": None,
        "study_id": None,
        "owner_id": 1,
        "created_at": datetime.now(),
        "completed_at": None,
    }


# =============================================================================
# FastAPI Test Client Fixture
# =============================================================================

@pytest.fixture
async def async_client():
    """Create an async test client for FastAPI app."""
    # Import here to avoid circular imports
    from main import app
    
    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client


# =============================================================================
# Email Fixtures
# =============================================================================

@pytest.fixture
def sample_share_notification_data():
    """Create sample data for share notification email."""
    return {
        "recipient_email": "recipient@example.com",
        "recipient_name": "Recipient User",
        "sharer_name": "Sharer User",
        "sharer_email": "sharer@example.com",
        "slide_name": "Test Slide H&E",
        "stain": "H&E",
        "patient_name": "John Doe",
        "case_accession": "ACC-2024-001",
        "patient_dob": "1980-01-01",
        "slide_id": "study-123-abc",
    }


# =============================================================================
# Annotation Fixtures
# =============================================================================

@pytest.fixture
def sample_annotation():
    """Create a sample annotation."""
    return {
        "id": "ann-123",
        "study_id": "study-123-abc",
        "type": "measurement",
        "tool": "line",
        "geometry": {
            "type": "LineString",
            "coordinates": [[100, 100], [200, 200]],
        },
        "properties": {
            "color": "#ff0000",
            "label": "Tumor boundary",
            "measurement_value": 150.5,
            "measurement_unit": "um",
        },
        "created_by": "testuser@example.com",
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }


# =============================================================================
# Orthanc Response Fixtures
# =============================================================================

@pytest.fixture
def orthanc_study_response():
    """Create a sample Orthanc study response."""
    return {
        "ID": "12345678-abcd-efgh-ijkl-mnopqrstuvwx",
        "IsStable": True,
        "LastUpdate": "20240115T120000",
        "MainDicomTags": {
            "AccessionNumber": "ACC-001",
            "PatientID": "P001",
            "PatientName": "Test^Patient",
            "StudyDate": "20240115",
            "StudyDescription": "WSI Study",
            "StudyID": "1",
            "StudyInstanceUID": "1.2.3.4.5.6.7.8.9",
        },
        "PatientMainDicomTags": {
            "PatientID": "P001",
            "PatientName": "Test^Patient",
        },
        "Series": ["series-1", "series-2"],
        "Type": "Study",
    }


@pytest.fixture
def orthanc_series_response():
    """Create a sample Orthanc series response."""
    return {
        "ID": "series-1",
        "MainDicomTags": {
            "Modality": "SM",
            "SeriesDescription": "WSI Pyramid",
            "SeriesInstanceUID": "1.2.3.4.5.6.7.8.9.10",
        },
        "Instances": ["instance-1", "instance-2"],
    }
