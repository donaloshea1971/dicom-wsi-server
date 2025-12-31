# C-STORE Test Suite for Orthanc DICOM Server

This directory contains a comprehensive test suite for validating DICOM C-STORE functionality in your Orthanc server.

## Quick Start

### Windows
```powershell
# Run all tests
.\run_tests.ps1

# Or manually
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python test_c_store.py
```

### Linux/Mac
```bash
# Run all tests
./run_tests.sh

# Or manually
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python test_c_store.py
```

## Files Overview

- **`test_c_store.py`** - Comprehensive test suite with 5 validation tests
- **`simple_c_store_client.py`** - Standalone client for sending DICOM files
- **`C_STORE_DOCUMENTATION.md`** - Complete configuration and usage guide
- **`requirements.txt`** - Python dependencies
- **`run_tests.ps1`** - Windows test runner
- **`run_tests.sh`** - Linux/Mac test runner

## Test Coverage

1. **Single File C-STORE** - Basic functionality test
2. **Batch C-STORE** - Multiple files in one association
3. **Wrong AE Title** - Error handling and configuration validation
4. **Large File Transfer** - Performance and stability test
5. **WSI File Transfer** - Whole Slide Imaging support

## Current Configuration

- **DICOM Port**: 4242
- **AE Title**: DIAGNEXIA
- **Authentication**: Accepts any calling AE (configurable)
- **HTTP API**: Port 8042 (admin/orthanc)

## Usage Examples

### Send a single file
```bash
python simple_c_store_client.py /path/to/image.dcm
```

### Send to remote server
```bash
python simple_c_store_client.py image.dcm --host 192.168.1.100 --port 4242
```

### Test with custom parameters
```bash
python test_c_store.py --host orthanc.example.com --username admin --password secret
```

## Verification

After running tests, verify storage:

1. **Web UI**: http://localhost:8042 (admin/orthanc)
2. **REST API**: 
   ```bash
   curl -u admin:orthanc http://localhost:8042/instances
   ```

## Troubleshooting

See `C_STORE_DOCUMENTATION.md` for:
- Network configuration
- External PACS setup
- Common issues and solutions
- Performance tuning
- Security considerations

## Success Criteria

✓ All 5 tests pass successfully  
✓ Files appear in Orthanc Web UI  
✓ REST API queries return stored instances  
✓ External PACS can send files  

## Next Steps

1. Test from your actual PACS system
2. Configure AE Title restrictions if needed
3. Set up monitoring for production use
4. Consider security hardening for external access
