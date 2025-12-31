# C-STORE Configuration and Testing Documentation

## Overview

This document provides comprehensive instructions for configuring and testing DICOM C-STORE functionality with the Orthanc DICOM server. C-STORE is part of the DIMSE (DICOM Message Service Element) protocol and allows DICOM devices to send images to the server.

## Current Configuration

### Orthanc Settings (orthanc.json)

The following settings enable C-STORE in Orthanc:

```json
{
  "DicomServerEnabled": true,          // Enables DICOM protocol
  "DicomAet": "DIAGNEXIA",             // Application Entity Title
  "DicomPort": 4242,                   // DICOM listening port
  "DicomCheckCalledAet": false,        // Accept any called AET
  "StrictAetComparison": false,        // Case-insensitive AET matching
  "UnknownSopClassAccepted": false,    // Reject unknown SOP classes
  "OverwriteInstances": true           // Allow overwriting existing instances
}
```

### Docker Configuration

Port 4242 is exposed in `docker-compose.yml`:

```yaml
orthanc:
  ports:
    - "8042:8042"   # HTTP/REST API
    - "4242:4242"   # DICOM port (C-STORE, C-FIND, etc.)
```

### Network Requirements

- **Internal Docker Network**: Services communicate via `dicom-network`
- **External Access**: Port 4242 must be accessible from sending devices
- **Firewall**: Ensure port 4242 is open for TCP connections

## Testing C-STORE

### 1. Install Test Dependencies

```bash
cd c_store_tests
pip install -r requirements.txt
```

### 2. Run Comprehensive Test Suite

```bash
# Test against local Orthanc
python test_c_store.py

# Test against remote Orthanc
python test_c_store.py --host 192.168.1.100 --username admin --password orthanc

# Test with custom AE Titles
python test_c_store.py --aet ORTHANC --calling-aet MYWORKSTATION
```

### 3. Send Individual Files

```bash
# Send single file
python simple_c_store_client.py /path/to/image.dcm

# Send to remote server
python simple_c_store_client.py image.dcm --host 192.168.1.100 --server-aet ORTHANC

# Send multiple files
python simple_c_store_client.py *.dcm
```

## Test Suite Details

The comprehensive test suite (`test_c_store.py`) validates:

### Test 1: Single File C-STORE
- Creates minimal DICOM dataset
- Sends via C-STORE
- Verifies storage via REST API
- Confirms metadata is queryable

### Test 2: Batch C-STORE
- Sends multiple files in one association
- Tests connection reuse
- Verifies all instances stored
- Validates batch processing

### Test 3: Wrong AE Title Handling
- Tests server's AET validation
- With current config (DicomCheckCalledAet=false), accepts any AET
- Useful for multi-vendor environments

### Test 4: Large File Transfer
- Tests with configurable file size (default 10MB)
- Validates buffer handling
- Ensures stability with larger datasets

### Test 5: WSI File Transfer
- Tests Whole Slide Imaging SOP Class
- Validates multi-frame support
- Ensures WSI plugin compatibility

## External PACS Configuration

To receive files from external PACS systems:

### 1. Configure Remote PACS

Add Orthanc as a remote destination:
- **AE Title**: DIAGNEXIA
- **Hostname/IP**: [Orthanc server IP]
- **Port**: 4242
- **Transfer Syntax**: Implicit VR Little Endian (default)

### 2. Network Considerations

```bash
# Test connectivity from remote system
telnet [orthanc-ip] 4242

# Or use netcat
nc -zv [orthanc-ip] 4242
```

### 3. Common PACS Systems

#### Horos/OsiriX
1. Preferences → Locations → Add
2. Enter Orthanc details
3. Test with "Verify" button
4. Send studies via right-click → Send To

#### dcm4chee
```bash
# Using dcm4che tools
storescu -c DIAGNEXIA@orthanc-server:4242 image.dcm
```

#### Commercial PACS
Most commercial PACS support DICOM destinations:
- GE PACS: Add as DICOM node
- Philips IntelliSpace: Configure in DICOM settings
- Siemens syngo: Add as send destination

## Monitoring and Troubleshooting

### 1. Check Orthanc Logs

```bash
# View live logs
docker logs -f dicom-orthanc

# Check for association requests
docker logs dicom-orthanc | grep "Association"
```

### 2. Verify Storage via REST API

```bash
# List recent instances
curl -u admin:orthanc http://localhost:8042/instances

# Search by patient name
curl -u admin:orthanc -X POST http://localhost:8042/tools/find \
  -d '{"Level":"Patient","Query":{"PatientName":"TEST*"}}'
```

### 3. Common Issues

#### Association Rejected
- Verify AE Titles match (or disable checking)
- Check network connectivity
- Ensure port 4242 is accessible

#### Storage Failed (Status != 0x0000)
- Check disk space
- Verify file format is valid DICOM
- Check Orthanc error logs

#### Files Not Appearing
- Allow time for processing (especially WSI)
- Check PostgreSQL connection
- Verify Orthanc plugins loaded

### 4. Performance Tuning

For high-volume C-STORE:

```json
{
  "ConcurrentJobs": 8,              // Increase parallel processing
  "HttpThreadsCount": 50,           // More HTTP threads
  "DicomScpTimeout": 30,            // Increase timeout for large files
  "MaximumStorageSize": 0,          // Unlimited storage
  "StorageCompression": false       // Disable for performance
}
```

## Security Considerations

### 1. Enable AET Checking

For production, consider:
```json
{
  "DicomCheckCalledAet": true,
  "DicomModalities": {
    "PACS1": ["PACS1", "192.168.1.100", 104],
    "WORKSTATION1": ["WORKSTATION1", "192.168.1.101", 104]
  }
}
```

### 2. Network Security
- Use VPN for external connections
- Implement firewall rules for source IPs
- Consider TLS wrapper (stunnel) for encryption

### 3. Access Control
- Limit C-STORE to specific AE Titles
- Use Lua scripts for custom validation
- Monitor access logs regularly

## Integration Examples

### Python Integration
```python
from pynetdicom import AE, StoragePresentationContexts

def send_to_orthanc(dicom_file_path):
    ae = AE(ae_title='PYTHON_APP')
    ae.requested_contexts = StoragePresentationContexts
    
    ds = dcmread(dicom_file_path)
    assoc = ae.associate('localhost', 4242, ae_title='DIAGNEXIA')
    
    if assoc.is_established:
        status = assoc.send_c_store(ds)
        assoc.release()
        return status.Status == 0x0000
    return False
```

### Command Line Tools
```bash
# Using dcm4che storescu
storescu -c DIAGNEXIA@localhost:4242 image.dcm

# Using dcmtk storescu
storescu localhost 4242 -aec DIAGNEXIA -aet MYSCU image.dcm
```

## Conclusion

The Orthanc DICOM server is fully configured to receive C-STORE requests. The provided test suite validates all major functionality, and the simple client script enables easy integration testing. For production use, consider enabling AET validation and implementing appropriate security measures.
