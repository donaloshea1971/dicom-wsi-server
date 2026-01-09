"""
Unit tests for the watcher.py module.

Tests cover:
- WSIFileHandler file detection
- File stability checking
- File processing submission
- Supported format validation
"""

import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add converter module to path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))


# =============================================================================
# Test WSIFileHandler
# =============================================================================

class TestWSIFileHandler:
    """Tests for the WSIFileHandler class."""

    def test_handler_initialization(self):
        """Test WSIFileHandler initializes correctly."""
        from watcher import WSIFileHandler
        
        handler = WSIFileHandler()
        
        assert handler.pending_files == {}
        assert handler.min_stable_time > 0

    def test_on_created_supported_format(self, temp_watch_folder):
        """Test on_created detects supported WSI formats."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        
        # Test each supported format
        supported_formats = [".ndpi", ".svs", ".tif", ".tiff", ".dcx", ".isyntax", 
                           ".mrxs", ".scn", ".bif", ".vsi"]
        
        for ext in supported_formats:
            file_path = str(temp_watch_folder["incoming"] / f"test_file{ext}")
            event = FileCreatedEvent(file_path)
            
            handler.on_created(event)
            
            assert file_path in handler.pending_files, f"Failed for {ext}"

    def test_on_created_unsupported_format(self, temp_watch_folder):
        """Test on_created ignores unsupported formats."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        
        unsupported_formats = [".txt", ".pdf", ".jpg", ".png", ".doc", ".exe"]
        
        for ext in unsupported_formats:
            file_path = str(temp_watch_folder["incoming"] / f"test_file{ext}")
            event = FileCreatedEvent(file_path)
            
            handler.on_created(event)
            
            assert file_path not in handler.pending_files

    def test_on_created_ignores_directories(self, temp_watch_folder):
        """Test on_created ignores directory creation events."""
        from watcher import WSIFileHandler
        from watchdog.events import DirCreatedEvent
        
        handler = WSIFileHandler()
        
        dir_path = str(temp_watch_folder["incoming"] / "new_folder")
        event = DirCreatedEvent(dir_path)
        
        handler.on_created(event)
        
        assert dir_path not in handler.pending_files

    def test_on_modified_updates_timestamp(self, temp_watch_folder):
        """Test on_modified updates file timestamp."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent, FileModifiedEvent
        
        handler = WSIFileHandler()
        
        file_path = str(temp_watch_folder["incoming"] / "test_file.svs")
        
        # First, create the file
        create_event = FileCreatedEvent(file_path)
        handler.on_created(create_event)
        
        initial_time = handler.pending_files[file_path]
        
        # Wait a bit
        time.sleep(0.1)
        
        # Then modify it
        modify_event = FileModifiedEvent(file_path)
        handler.on_modified(modify_event)
        
        # Timestamp should be updated
        assert handler.pending_files[file_path] >= initial_time

    def test_on_modified_ignores_unknown_files(self, temp_watch_folder):
        """Test on_modified ignores files not in pending."""
        from watcher import WSIFileHandler
        from watchdog.events import FileModifiedEvent
        
        handler = WSIFileHandler()
        
        file_path = str(temp_watch_folder["incoming"] / "unknown.svs")
        event = FileModifiedEvent(file_path)
        
        # Should not raise error
        handler.on_modified(event)
        
        assert file_path not in handler.pending_files

    def test_on_modified_ignores_directories(self, temp_watch_folder):
        """Test on_modified ignores directory events."""
        from watcher import WSIFileHandler
        from watchdog.events import DirModifiedEvent
        
        handler = WSIFileHandler()
        
        dir_path = str(temp_watch_folder["incoming"])
        event = DirModifiedEvent(dir_path)
        
        # Should not raise error
        handler.on_modified(event)


# =============================================================================
# Test File Stability Checking
# =============================================================================

class TestFileStability:
    """Tests for file stability checking."""

    def test_check_stable_files_empty(self):
        """Test check_stable_files with no pending files."""
        from watcher import WSIFileHandler
        
        handler = WSIFileHandler()
        
        stable = handler.check_stable_files()
        
        assert stable == []

    def test_check_stable_files_not_ready(self, temp_watch_folder, sample_wsi_file):
        """Test check_stable_files with recently added file."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        handler.min_stable_time = 5  # 5 seconds
        
        event = FileCreatedEvent(str(sample_wsi_file))
        handler.on_created(event)
        
        # File just added, should not be stable yet
        stable = handler.check_stable_files()
        
        assert stable == []
        assert str(sample_wsi_file) in handler.pending_files

    def test_check_stable_files_ready(self, temp_watch_folder, sample_wsi_file):
        """Test check_stable_files with file that has been stable."""
        from watcher import WSIFileHandler
        
        handler = WSIFileHandler()
        handler.min_stable_time = 0  # Immediate for testing
        
        # Add file with old timestamp
        file_path = str(sample_wsi_file)
        handler.pending_files[file_path] = time.time() - 10  # 10 seconds ago
        
        stable = handler.check_stable_files()
        
        assert file_path in stable
        assert file_path not in handler.pending_files

    def test_check_stable_files_removes_missing(self, temp_watch_folder):
        """Test check_stable_files removes files that no longer exist."""
        from watcher import WSIFileHandler
        
        handler = WSIFileHandler()
        handler.min_stable_time = 0
        
        # Add non-existent file with old timestamp
        file_path = str(temp_watch_folder["incoming"] / "missing.svs")
        handler.pending_files[file_path] = time.time() - 10
        
        stable = handler.check_stable_files()
        
        # File doesn't exist, so not returned as stable
        assert file_path not in stable
        # Should be removed from pending
        assert file_path not in handler.pending_files


# =============================================================================
# Test File Processing
# =============================================================================

class TestFileProcessing:
    """Tests for file processing submission."""

    @pytest.mark.asyncio
    async def test_process_file_success(self, sample_wsi_file, monkeypatch):
        """Test successful file processing submission."""
        from watcher import process_file
        
        # Mock httpx client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"job_id": "job-123"}
        
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        
        with patch("watcher.httpx.AsyncClient", return_value=mock_client):
            await process_file(str(sample_wsi_file))
            
            # Should have called POST with file
            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            assert "upload" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_process_file_failure(self, sample_wsi_file, monkeypatch):
        """Test file processing with server error."""
        from watcher import process_file
        
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Server Error"
        
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        
        with patch("watcher.httpx.AsyncClient", return_value=mock_client):
            # Should not raise, just log error
            await process_file(str(sample_wsi_file))

    @pytest.mark.asyncio
    async def test_process_file_exception(self, sample_wsi_file, monkeypatch):
        """Test file processing with exception."""
        from watcher import process_file
        
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=Exception("Connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        
        with patch("watcher.httpx.AsyncClient", return_value=mock_client):
            # Should not raise, just log error
            await process_file(str(sample_wsi_file))


# =============================================================================
# Test Supported Extensions
# =============================================================================

class TestSupportedExtensions:
    """Tests for supported file extension validation."""

    def test_supported_extensions_set(self):
        """Test SUPPORTED_EXTENSIONS constant is properly defined."""
        from watcher import SUPPORTED_EXTENSIONS
        
        # Should be a set
        assert isinstance(SUPPORTED_EXTENSIONS, set)
        
        # Should contain common WSI formats
        assert ".svs" in SUPPORTED_EXTENSIONS
        assert ".ndpi" in SUPPORTED_EXTENSIONS
        assert ".tiff" in SUPPORTED_EXTENSIONS
        assert ".isyntax" in SUPPORTED_EXTENSIONS

    def test_supported_extensions_lowercase(self):
        """Test all supported extensions are lowercase."""
        from watcher import SUPPORTED_EXTENSIONS
        
        for ext in SUPPORTED_EXTENSIONS:
            assert ext.startswith(".")
            assert ext == ext.lower()

    def test_file_handler_uses_supported_extensions(self, temp_watch_folder):
        """Test file handler correctly uses SUPPORTED_EXTENSIONS."""
        from watcher import WSIFileHandler, SUPPORTED_EXTENSIONS
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        
        for ext in SUPPORTED_EXTENSIONS:
            file_path = str(temp_watch_folder["incoming"] / f"test{ext}")
            event = FileCreatedEvent(file_path)
            handler.on_created(event)
            
            assert file_path in handler.pending_files, f"Should handle {ext}"


# =============================================================================
# Test Configuration
# =============================================================================

class TestWatcherConfiguration:
    """Tests for watcher configuration."""

    def test_watch_folder_env_var(self, monkeypatch):
        """Test WATCH_FOLDER environment variable."""
        import watcher
        import importlib
        
        monkeypatch.setenv("WATCH_FOLDER", "/custom/uploads")
        importlib.reload(watcher)
        
        assert watcher.WATCH_FOLDER == "/custom/uploads"

    def test_watch_folder_default(self, monkeypatch):
        """Test WATCH_FOLDER default value."""
        import watcher
        import importlib
        
        monkeypatch.delenv("WATCH_FOLDER", raising=False)
        importlib.reload(watcher)
        
        assert watcher.WATCH_FOLDER == "/uploads"

    def test_converter_url_env_var(self, monkeypatch):
        """Test CONVERTER_INTERNAL_URL environment variable."""
        import watcher
        import importlib
        
        monkeypatch.setenv("CONVERTER_INTERNAL_URL", "http://custom:9000")
        importlib.reload(watcher)
        
        assert watcher.CONVERTER_URL == "http://custom:9000"


# =============================================================================
# Test Case Sensitivity
# =============================================================================

class TestCaseSensitivity:
    """Tests for file extension case sensitivity."""

    def test_uppercase_extension_detected(self, temp_watch_folder):
        """Test that uppercase extensions are handled."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        
        # Test with uppercase extension
        file_path = str(temp_watch_folder["incoming"] / "test_file.SVS")
        event = FileCreatedEvent(file_path)
        
        handler.on_created(event)
        
        # Should be detected (handler converts to lowercase)
        assert file_path in handler.pending_files

    def test_mixed_case_extension_detected(self, temp_watch_folder):
        """Test that mixed case extensions are handled."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        
        file_path = str(temp_watch_folder["incoming"] / "test_file.Ndpi")
        event = FileCreatedEvent(file_path)
        
        handler.on_created(event)
        
        assert file_path in handler.pending_files


# =============================================================================
# Test Multiple Files
# =============================================================================

class TestMultipleFiles:
    """Tests for handling multiple files."""

    def test_multiple_files_pending(self, temp_watch_folder):
        """Test tracking multiple pending files."""
        from watcher import WSIFileHandler
        from watchdog.events import FileCreatedEvent
        
        handler = WSIFileHandler()
        
        files = [
            temp_watch_folder["incoming"] / "file1.svs",
            temp_watch_folder["incoming"] / "file2.ndpi",
            temp_watch_folder["incoming"] / "file3.tiff",
        ]
        
        # Create all files
        for f in files:
            f.write_bytes(b"test content")
        
        # Add events
        for f in files:
            event = FileCreatedEvent(str(f))
            handler.on_created(event)
        
        assert len(handler.pending_files) == 3
        for f in files:
            assert str(f) in handler.pending_files

    def test_mixed_stable_not_stable_files(self, temp_watch_folder):
        """Test check_stable_files with mix of stable and unstable files."""
        from watcher import WSIFileHandler
        
        handler = WSIFileHandler()
        handler.min_stable_time = 5  # 5 seconds
        
        # Create test files
        stable_file = temp_watch_folder["incoming"] / "stable.svs"
        unstable_file = temp_watch_folder["incoming"] / "unstable.svs"
        
        stable_file.write_bytes(b"stable content")
        unstable_file.write_bytes(b"unstable content")
        
        # Add files with different timestamps
        handler.pending_files[str(stable_file)] = time.time() - 10  # Old
        handler.pending_files[str(unstable_file)] = time.time()  # Just now
        
        stable = handler.check_stable_files()
        
        assert str(stable_file) in stable
        assert str(unstable_file) not in stable
        # Stable file removed from pending
        assert str(stable_file) not in handler.pending_files
        # Unstable file still in pending
        assert str(unstable_file) in handler.pending_files
