#!/usr/bin/env python3
"""Upload all test DICOM data via C-STORE proxy - Fixed version"""

import sys
import time
from pathlib import Path
from pydicom import dcmread
from pynetdicom import AE
from pynetdicom.sop_class import (
    VLWholeSlideMicroscopyImageStorage,
    CTImageStorage,
    MRImageStorage,
    SecondaryCaptureImageStorage,
)

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Configuration
PROXY_HOST = "localhost"
PROXY_PORT = 4243
PROXY_AET = "CSTORE_PROXY"

def upload_file(file_path, ae):
    """Upload a single DICOM file via C-STORE"""
    try:
        # Read file
        ds = dcmread(file_path, force=True)
        
        # Get metadata
        patient_name = str(ds.get("PatientName", "Unknown"))
        modality = ds.get("Modality", "Unknown")
        sop_class_uid = ds.get("SOPClassUID", "")
        transfer_syntax = ds.file_meta.get("TransferSyntaxUID", "1.2.840.10008.1.2")
        
        print(f"  {file_path.name}")
        print(f"    Patient: {patient_name}")
        print(f"    Modality: {modality}")
        print(f"    Transfer Syntax: {transfer_syntax}")
        
        # Associate and send
        assoc = ae.associate(PROXY_HOST, PROXY_PORT, ae_title=PROXY_AET)
        
        if assoc.is_established:
            status = assoc.send_c_store(ds)
            assoc.release()
            
            if status and status.Status == 0x0000:
                print(f"    ✓ SUCCESS")
                return True
            else:
                print(f"    ✗ Failed: Status 0x{status.Status:04X}")
                return False
        else:
            print(f"    ✗ Failed: Association rejected")
            if assoc.rejected_contexts:
                print(f"    Rejected contexts: {assoc.rejected_contexts}")
            return False
            
    except Exception as e:
        print(f"    ✗ Error: {str(e)[:100]}")
        return False

def main():
    print("="*70)
    print("Uploading All Test DICOM Data via C-STORE Proxy (Fixed)")
    print("="*70)
    print(f"Proxy: {PROXY_AET}@{PROXY_HOST}:{PROXY_PORT}")
    print()
    
    # Create AE with standard SOP classes
    ae = AE()
    
    # Add common SOP classes - the proxy will handle transfer syntax negotiation
    ae.add_requested_context(VLWholeSlideMicroscopyImageStorage)
    ae.add_requested_context(CTImageStorage)
    ae.add_requested_context(MRImageStorage)
    ae.add_requested_context(SecondaryCaptureImageStorage)
    
    # Test data directories
    test_dirs = [
        ("Leica WSI", Path("testdata/DICOM-native/Leica-4")),
        ("3DHISTECH-1", Path("testdata/DICOM-native/3DHISTECH-1")),
        ("3DHISTECH-2", Path("testdata/DICOM-native/3DHISTECH-2")),
        ("CMU JP2K", Path("testdata/DICOM-native/CMU-1-JP2K-33005")),
        ("JP2K-33003", Path("testdata/DICOM-native/JP2K-33003-1")),
    ]
    
    total_success = 0
    total_failed = 0
    
    for name, test_dir in test_dirs:
        if test_dir.exists():
            print(f"\n{name} ({test_dir}):")
            
            # Find DICOM files
            dcm_files = list(test_dir.glob("*.dcm"))
            if not dcm_files:
                # Try without extension
                dcm_files = [f for f in test_dir.iterdir() if f.is_file() and not f.name.startswith('.')]
            
            # Upload files
            for file_path in dcm_files[:5]:  # Limit to 5 files per directory for testing
                if upload_file(file_path, ae):
                    total_success += 1
                else:
                    total_failed += 1
                time.sleep(0.2)  # Small delay between uploads
        else:
            print(f"\nSkipping {name} (not found)")
    
    # Also upload test CT files
    print("\nTest CT files:")
    test_files = [
        Path("c_store_tests/test_ct.dcm"),
        Path("c_store_tests/test_ct_image.dcm"),
    ]
    
    for test_file in test_files:
        if test_file.exists():
            if upload_file(test_file, ae):
                total_success += 1
            else:
                total_failed += 1
    
    print("\n" + "="*70)
    print(f"Upload Summary:")
    print(f"  ✓ Successful: {total_success}")
    print(f"  ✗ Failed: {total_failed}")
    print(f"  Total: {total_success + total_failed}")
    
    # Verify in Orthanc
    print("\nVerifying in Orthanc...")
    time.sleep(3)
    
    import requests
    auth = ("admin", "orthanc")
    response = requests.get("http://localhost:8042/statistics", auth=auth)
    if response.status_code == 200:
        stats = response.json()
        print(f"  Studies: {stats.get('CountStudies', 0)}")
        print(f"  Series: {stats.get('CountSeries', 0)}")
        print(f"  Instances: {stats.get('CountInstances', 0)}")

if __name__ == "__main__":
    main()
