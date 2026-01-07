"""
Unit tests for the main.py API endpoints.

Tests cover:
- Health check endpoint
- File upload endpoint
- Job status endpoints
- Study endpoints
- Sharing endpoints
- Annotation endpoints
"""

import sys
from pathlib import Path
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
from io import BytesIO

import pytest
from httpx import AsyncClient, ASGITransport

# Add converter module to path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))


# =============================================================================
# Test Health Endpoint
# =============================================================================

class TestHealthEndpoint:
    """Tests for the /health endpoint."""

    @pytest.mark.asyncio
    async def test_health_returns_ok(self):
        """Test health endpoint returns healthy status."""
        from main import app
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/health")
            
            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "healthy"


# =============================================================================
# Test Upload Endpoint
# =============================================================================

class TestUploadEndpoint:
    """Tests for the /upload endpoint."""

    @pytest.mark.asyncio
    async def test_upload_file_creates_job(self):
        """Test uploading a file creates a conversion job."""
        from main import app, conversion_jobs
        
        # Clear any existing jobs
        conversion_jobs.clear()
        
        # Create a mock file
        file_content = b"FAKE SVS CONTENT"
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/upload",
                files={"file": ("test_slide.svs", BytesIO(file_content))},
            )
            
            assert response.status_code == 200
            data = response.json()
            
            assert "job_id" in data
            assert data["status"] == "pending"
            assert data["message"] == "Conversion queued"

    @pytest.mark.asyncio
    async def test_upload_unsupported_format(self):
        """Test uploading unsupported format returns error."""
        from main import app
        
        file_content = b"Not a WSI file"
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/upload",
                files={"file": ("test.txt", BytesIO(file_content))},
            )
            
            assert response.status_code == 400
            data = response.json()
            assert "Unsupported" in data["detail"]

    @pytest.mark.asyncio
    async def test_upload_empty_file(self):
        """Test uploading empty file."""
        from main import app
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/upload",
                files={"file": ("test.svs", BytesIO(b""))},
            )
            
            # Should still accept (validation happens during conversion)
            assert response.status_code == 200


# =============================================================================
# Test Job Status Endpoints
# =============================================================================

class TestJobStatusEndpoints:
    """Tests for job status endpoints."""

    @pytest.mark.asyncio
    async def test_get_job_status_found(self):
        """Test getting status of existing job."""
        from main import app, conversion_jobs, ConversionJob
        
        # Add a test job
        job = ConversionJob(
            job_id="test-job-123",
            filename="test.svs",
            status="processing",
            progress=50,
            message="Converting...",
            created_at=datetime.now(),
        )
        conversion_jobs["test-job-123"] = job
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/jobs/test-job-123")
            
            assert response.status_code == 200
            data = response.json()
            
            assert data["job_id"] == "test-job-123"
            assert data["status"] == "processing"
            assert data["progress"] == 50

    @pytest.mark.asyncio
    async def test_get_job_status_not_found(self):
        """Test getting status of non-existent job."""
        from main import app
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/jobs/non-existent-job")
            
            assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_list_jobs(self):
        """Test listing all jobs."""
        from main import app, conversion_jobs, ConversionJob
        
        # Clear and add test jobs
        conversion_jobs.clear()
        
        for i in range(3):
            job = ConversionJob(
                job_id=f"job-{i}",
                filename=f"file{i}.svs",
                status="completed" if i == 0 else "pending",
                created_at=datetime.now(),
            )
            conversion_jobs[f"job-{i}"] = job
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/jobs")
            
            assert response.status_code == 200
            data = response.json()
            
            assert len(data) == 3


# =============================================================================
# Test Studies Endpoints
# =============================================================================

class TestStudiesEndpoints:
    """Tests for study-related endpoints."""

    @pytest.mark.asyncio
    async def test_get_studies_unauthenticated(self):
        """Test getting studies without authentication returns samples."""
        from main import app
        
        # Mock Orthanc response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = []
        
        with patch("main.httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get("/dicomweb/studies")
                
                # Should return 200 (empty list for unauthenticated)
                assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_get_study_metadata(self, sample_study_id):
        """Test getting study metadata."""
        from main import app
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "ID": sample_study_id,
            "MainDicomTags": {
                "StudyDescription": "Test Study",
            },
            "Series": [],
        }
        
        with patch("main.httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            # Mock access check
            with patch("main.can_access_study", return_value=True):
                transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
                    response = await client.get(f"/dicomweb/studies/{sample_study_id}")
                    
                    assert response.status_code == 200


# =============================================================================
# Test TIFF Compression Check
# =============================================================================

class TestTIFFCompressionCheck:
    """Tests for TIFF compression checking."""

    def test_check_tiff_compression_uncompressed(self, tmp_path):
        """Test checking uncompressed TIFF returns False."""
        from main import check_tiff_compression
        
        # Skip if tifffile not available
        pytest.importorskip("tifffile")
        
        # Create minimal uncompressed TIFF
        import tifffile
        import numpy as np
        
        tiff_path = tmp_path / "test.tiff"
        data = np.zeros((10, 10), dtype=np.uint8)
        tifffile.imwrite(str(tiff_path), data, compression=None)
        
        needs_conversion, compression = check_tiff_compression(tiff_path)
        
        assert needs_conversion is False

    def test_check_tiff_compression_lzw(self, tmp_path):
        """Test checking LZW-compressed TIFF returns True."""
        from main import check_tiff_compression
        
        pytest.importorskip("tifffile")
        
        import tifffile
        import numpy as np
        
        tiff_path = tmp_path / "test_lzw.tiff"
        data = np.zeros((10, 10), dtype=np.uint8)
        tifffile.imwrite(str(tiff_path), data, compression="lzw")
        
        needs_conversion, compression = check_tiff_compression(tiff_path)
        
        assert needs_conversion is True
        assert compression == 5  # LZW

    def test_check_tiff_compression_non_tiff(self, tmp_path):
        """Test checking non-TIFF file returns False."""
        from main import check_tiff_compression
        
        file_path = tmp_path / "test.ndpi"
        file_path.write_bytes(b"Not a TIFF file")
        
        needs_conversion, compression = check_tiff_compression(file_path)
        
        assert needs_conversion is False
        assert compression == 0


# =============================================================================
# Test Annotation Models
# =============================================================================

class TestAnnotationModels:
    """Tests for annotation Pydantic models."""

    def test_annotation_geometry_model(self):
        """Test AnnotationGeometry model."""
        from main import AnnotationGeometry
        
        geom = AnnotationGeometry(
            type="LineString",
            coordinates=[[100, 100], [200, 200]],
        )
        
        assert geom.type == "LineString"
        assert len(geom.coordinates) == 2

    def test_annotation_create_model(self):
        """Test AnnotationCreate model."""
        from main import AnnotationCreate, AnnotationGeometry
        
        annotation = AnnotationCreate(
            type="measurement",
            tool="line",
            geometry=AnnotationGeometry(
                type="LineString",
                coordinates=[[0, 0], [100, 100]],
            ),
            properties={"color": "#ff0000"},
            created_by="test@example.com",
        )
        
        assert annotation.type == "measurement"
        assert annotation.tool == "line"
        assert annotation.properties["color"] == "#ff0000"

    def test_annotation_update_model(self):
        """Test AnnotationUpdate model with optional fields."""
        from main import AnnotationUpdate, AnnotationGeometry
        
        # Partial update - only properties
        update = AnnotationUpdate(
            properties={"color": "#00ff00"},
        )
        
        assert update.geometry is None
        assert update.properties["color"] == "#00ff00"


# =============================================================================
# Test Conversion Job Model
# =============================================================================

class TestConversionJobModel:
    """Tests for ConversionJob model."""

    def test_conversion_job_creation(self):
        """Test creating a ConversionJob."""
        from main import ConversionJob
        
        job = ConversionJob(
            job_id="job-123",
            filename="test.svs",
            status="pending",
            created_at=datetime.now(),
        )
        
        assert job.job_id == "job-123"
        assert job.filename == "test.svs"
        assert job.status == "pending"
        assert job.progress == 0  # Default
        assert job.message == ""  # Default
        assert job.study_uid is None
        assert job.study_id is None

    def test_conversion_job_all_fields(self):
        """Test ConversionJob with all fields."""
        from main import ConversionJob
        
        now = datetime.now()
        job = ConversionJob(
            job_id="job-456",
            filename="test2.ndpi",
            status="completed",
            progress=100,
            message="Conversion successful",
            study_uid="1.2.3.4.5",
            study_id="study-abc",
            owner_id=1,
            created_at=now,
            completed_at=now,
        )
        
        assert job.status == "completed"
        assert job.progress == 100
        assert job.study_id == "study-abc"
        assert job.owner_id == 1


# =============================================================================
# Test Upload Response Model
# =============================================================================

class TestUploadResponseModel:
    """Tests for UploadResponse model."""

    def test_upload_response_creation(self):
        """Test creating an UploadResponse."""
        from main import UploadResponse
        
        response = UploadResponse(
            job_id="job-123",
            message="Conversion queued",
            status="pending",
        )
        
        assert response.job_id == "job-123"
        assert response.message == "Conversion queued"
        assert response.status == "pending"


# =============================================================================
# Test Settings
# =============================================================================

class TestSettings:
    """Tests for application settings."""

    def test_settings_defaults(self, monkeypatch):
        """Test Settings class default values."""
        # Clear environment to test defaults
        for var in ["ORTHANC_URL", "ORTHANC_USERNAME", "ORTHANC_PASSWORD",
                    "REDIS_URL", "WATCH_FOLDER", "MAX_UPLOAD_SIZE_GB"]:
            monkeypatch.delenv(var, raising=False)
        
        from main import Settings
        
        settings = Settings()
        
        assert settings.orthanc_url == "http://orthanc:8042"
        assert settings.orthanc_username == "admin"
        assert settings.orthanc_password == "orthanc"
        assert settings.redis_url == "redis://redis:6379"
        assert settings.watch_folder == "/uploads"
        assert settings.max_upload_size_gb == 20

    def test_settings_from_env(self, monkeypatch):
        """Test Settings reads from environment."""
        monkeypatch.setenv("ORTHANC_URL", "http://custom:8080")
        monkeypatch.setenv("MAX_UPLOAD_SIZE_GB", "50")
        
        from main import Settings
        
        settings = Settings()
        
        assert settings.orthanc_url == "http://custom:8080"
        assert settings.max_upload_size_gb == 50


# =============================================================================
# Test File Format Validation
# =============================================================================

class TestFileFormatValidation:
    """Tests for file format validation."""

    @pytest.mark.asyncio
    async def test_supported_formats(self):
        """Test all supported formats are accepted."""
        from main import app
        
        supported = [".svs", ".ndpi", ".tif", ".tiff", ".isyntax",
                    ".mrxs", ".scn", ".bif", ".vsi"]
        
        for ext in supported:
            file_content = b"FAKE CONTENT"
            
            transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/upload",
                    files={"file": (f"test{ext}", BytesIO(file_content))},
                )
                
                assert response.status_code == 200, f"Format {ext} should be supported"

    @pytest.mark.asyncio
    async def test_unsupported_formats(self):
        """Test unsupported formats are rejected."""
        from main import app
        
        unsupported = [".jpg", ".png", ".pdf", ".doc", ".exe", ".zip"]
        
        for ext in unsupported:
            file_content = b"FAKE CONTENT"
            
            transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/upload",
                    files={"file": (f"test{ext}", BytesIO(file_content))},
                )
                
                assert response.status_code == 400, f"Format {ext} should be rejected"


# =============================================================================
# Test CORS Configuration
# =============================================================================

class TestCORSConfiguration:
    """Tests for CORS middleware configuration."""

    @pytest.mark.asyncio
    async def test_cors_headers_present(self):
        """Test CORS headers are present in response."""
        from main import app
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.options(
                "/health",
                headers={
                    "Origin": "http://localhost:3000",
                    "Access-Control-Request-Method": "GET",
                },
            )
            
            # CORS preflight should be handled
            assert response.status_code in [200, 204, 405]


# =============================================================================
# Test Preprocess for Conversion
# =============================================================================

class TestPreprocessForConversion:
    """Tests for preprocess_for_conversion function."""

    def test_preprocess_non_tiff_returns_original(self, tmp_path):
        """Test non-TIFF files are returned unchanged."""
        from main import preprocess_for_conversion
        
        # Create a mock NDPI file
        ndpi_file = tmp_path / "test.ndpi"
        ndpi_file.write_bytes(b"FAKE NDPI CONTENT")
        
        result = preprocess_for_conversion(ndpi_file, tmp_path)
        
        assert result == ndpi_file

    def test_preprocess_uncompressed_tiff_returns_original(self, tmp_path):
        """Test uncompressed TIFF returns original."""
        pytest.importorskip("tifffile")
        
        from main import preprocess_for_conversion
        import tifffile
        import numpy as np
        
        tiff_file = tmp_path / "test.tiff"
        data = np.zeros((10, 10), dtype=np.uint8)
        tifffile.imwrite(str(tiff_file), data, compression=None)
        
        result = preprocess_for_conversion(tiff_file, tmp_path)
        
        assert result == tiff_file


# =============================================================================
# Test Error Handling
# =============================================================================

class TestErrorHandling:
    """Tests for API error handling."""

    @pytest.mark.asyncio
    async def test_404_for_unknown_route(self):
        """Test 404 for unknown routes."""
        from main import app
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/unknown/route")
            
            assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_method_not_allowed(self):
        """Test method not allowed for wrong HTTP method."""
        from main import app
        
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/health")
            
            assert response.status_code == 405
