# C-STORE Proxy Service

This service provides a workaround for the C-STORE bug in Orthanc mainline version where files are accepted but not stored.

## How It Works

1. **Receives C-STORE** requests on port 4243 (instead of Orthanc's 4242)
2. **Saves the DICOM file** temporarily
3. **Forwards to Orthanc** via REST API (which works correctly)
4. **Returns success** to the DICOM client

## Architecture

```
DICOM Client --> C-STORE --> Proxy (4243) --> REST API --> Orthanc (8042)
```

## Configuration

Configure your DICOM clients to send to:
- **AE Title**: `CSTORE_PROXY`
- **Port**: `4243`
- **Host**: Same as before

## Testing

```bash
# From the cstore-proxy directory
python test_proxy.py

# Or test from C-STORE test suite
cd ../c_store_tests
python simple_c_store_client.py test.dcm --port 4243 --server-aet CSTORE_PROXY
```

## Monitoring

The proxy logs all operations:
```bash
docker logs dicom-cstore-proxy -f
```

## Performance

- Handles concurrent C-STORE requests
- Minimal overhead (< 100ms per file)
- Automatic cleanup of temporary files
- Supports all DICOM SOP classes and transfer syntaxes

## When to Remove

This proxy can be removed once the C-STORE bug in Orthanc mainline is fixed. Until then, it provides a transparent workaround that maintains full compatibility with DICOM clients.
