# DICOM WSI Server Test Suite

This directory contains the unit test suite for the DICOM WSI Server application.

## Test Structure

```
tests/
├── __init__.py           # Test package marker
├── conftest.py           # Shared pytest fixtures
├── test_auth.py          # Authentication module tests
├── test_email_service.py # Email service tests
├── test_icc_parser.py    # ICC profile parser tests
├── test_watcher.py       # File watcher tests
├── test_api.py           # API endpoint tests
└── README.md             # This file
```

## Running Tests

### Prerequisites

Install test dependencies:

```bash
pip install -r requirements-test.txt
```

### Run All Tests

```bash
# From the project root directory
pytest

# With verbose output
pytest -v

# With coverage report
pytest --cov=converter --cov-report=html
```

### Run Specific Test Files

```bash
# Run only auth tests
pytest tests/test_auth.py

# Run only API tests
pytest tests/test_api.py
```

### Run by Markers

```bash
# Run only unit tests (no external dependencies)
pytest -m unit

# Skip slow tests
pytest -m "not slow"

# Run auth-related tests
pytest -m auth
```

### Run Specific Test Classes or Functions

```bash
# Run a specific test class
pytest tests/test_auth.py::TestUserModel

# Run a specific test function
pytest tests/test_auth.py::TestUserModel::test_user_model_with_all_fields
```

## Test Categories

### Unit Tests (`test_*.py`)

- **test_auth.py**: Tests for JWT authentication, user management, study ownership, slide sharing, and access control
- **test_email_service.py**: Tests for email configuration, sending emails via Brevo API, share notifications
- **test_icc_parser.py**: Tests for ICC profile parsing, gamma extraction, color matrix building
- **test_watcher.py**: Tests for file watcher service, file detection, stability checking
- **test_api.py**: Tests for FastAPI endpoints, upload handling, job status, CORS

## Fixtures

Common fixtures are defined in `conftest.py`:

- `mock_env_vars`: Sets up test environment variables
- `mock_db_pool`, `mock_db_connection`: Database mocking
- `sample_user`, `sample_admin_user`: User fixtures
- `sample_study_id`, `sample_slide`, `sample_case`: DICOM/slide fixtures
- `sample_icc_header`, `minimal_icc_profile`: ICC profile fixtures
- `temp_watch_folder`, `sample_wsi_file`: File system fixtures
- `sample_job`: Conversion job fixtures
- `sample_annotation`: Annotation fixtures

## Writing New Tests

### Basic Test Structure

```python
import pytest
from unittest.mock import AsyncMock, patch

class TestMyFeature:
    """Tests for my feature."""
    
    def test_sync_function(self):
        """Test a synchronous function."""
        result = my_function()
        assert result == expected
    
    @pytest.mark.asyncio
    async def test_async_function(self):
        """Test an asynchronous function."""
        result = await my_async_function()
        assert result == expected
    
    def test_with_fixture(self, sample_user):
        """Test using a fixture."""
        assert sample_user["email"] == "testuser@example.com"
    
    def test_with_mock(self):
        """Test with mocking."""
        with patch("module.function") as mock_func:
            mock_func.return_value = "mocked"
            result = function_under_test()
            assert result == "mocked"
```

### Adding Markers

```python
@pytest.mark.unit
def test_unit_only():
    """This is a unit test."""
    pass

@pytest.mark.integration
def test_needs_services():
    """This needs external services."""
    pass

@pytest.mark.slow
def test_long_running():
    """This test takes a long time."""
    pass
```

## Coverage

Generate a coverage report:

```bash
# Text report
pytest --cov=converter --cov-report=term-missing

# HTML report (opens in browser)
pytest --cov=converter --cov-report=html
open htmlcov/index.html
```

## Continuous Integration

These tests are designed to run in CI environments without external dependencies.
All external services (database, Orthanc, Redis) are mocked in unit tests.

For integration tests that need real services, use Docker Compose:

```bash
docker-compose -f docker-compose.test.yml up -d
pytest -m integration
docker-compose -f docker-compose.test.yml down
```

## Troubleshooting

### Import Errors

If you get import errors, make sure the converter module is in the Python path:

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))
```

### Async Test Issues

Make sure `pytest-asyncio` is installed and configured:

```ini
# pytest.ini
asyncio_mode = auto
```

### Mock Not Applied

Ensure you're patching at the correct location (where the object is used, not where it's defined):

```python
# If main.py does: from auth import get_db_pool
# Patch in main, not auth:
with patch("main.get_db_pool"):
    ...
```
