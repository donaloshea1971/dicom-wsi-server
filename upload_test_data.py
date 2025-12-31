#!/usr/bin/env python3
"""Upload all test DICOM data to Orthanc via C-STORE proxy"""

import sys
import os
import time
from pathlib import Path
from pydicom import dcmread
from pynetdicom import AE, ALL_TRANSFER_SYNTAXES
from pynetdicom.sop_class import (
    VLWholeSlideMicroscopyImageStorage,
    CTImageStorage,
    MRImageStorage,
    SecondaryCaptureImageStorage
)

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Configuration
PROXY_HOST = "localhost"
PROXY_PORT = 4243
PROXY_AET = "CSTORE_PROXY"

def get_sop_class_for_modality(modality):
    """Get appropriate SOP class for modality"""
    modality_map = {
        "CT": CTImageStorage,
        "MR": MRImageStorage,
        "SM": VLWholeSlideMicroscopyImageStorage,
        "OT": SecondaryCaptureImageStorage,
    }
    return modality_map.get(modality, SecondaryCaptureImageStorage)

def upload_dicom_file(file_path, ae):
    """Upload a single DICOM file"""
    try:
        # Read file
        ds = dcmread(file_path, force=True)
        
        # Get metadata
        patient_name = str(ds.get("PatientName", "Unknown"))
        modality = ds.get("Modality", "OT")
        sop_uid = ds.get("SOPInstanceUID", "Unknown")
        
        print(f"  Uploading: {patient_name} ({modality}) - {file_path.name}")
        
        # Get SOP class
        sop_class = get_sop_class_for_modality(modality)
        
        # Ensure context is added with all transfer syntaxes
        if not any(cx.abstract_syntax == sop_class for cx in ae.requested_contexts):
            ae.add_requested_context(sop_class, ALL_TRANSFER_SYNTAXES)
        
        # Associate and send
        assoc = ae.associate(PROXY_HOST, PROXY_PORT, ae_title=PROXY_AET)
        
        if assoc.is_established:
            status = assoc.send_c_store(ds)
            assoc.release()
            
            if status and status.Status == 0x0000:
                print(f"    ✓ Success")
                return True
            else:
                print(f"    ✗ Failed: Status 0x{status.Status:04X}")
                return False
        else:
            print(f"    ✗ Failed: Association rejected")
            return False
            
    except Exception as e:
        print(f"    ✗ Error: {e}")
        return False

def upload_directory(dir_path, ae):
    """Upload all DICOM files in a directory"""
    success = 0
    failed = 0
    
    # Find all .dcm files
    dcm_files = list(dir_path.glob("*.dcm"))
    if not dcm_files:
        # Try without extension
        dcm_files = [f for f in dir_path.iterdir() if f.is_file() and not f.name.startswith('.')]
    
    for file_path in dcm_files:
        if upload_dicom_file(file_path, ae):
            success += 1
        else:
            failed += 1
        time.sleep(0.1)  # Small delay between uploads
    
    return success, failed

def main():
    """Upload all test data"""
    print("="*60)
    print("Uploading Test DICOM Data via C-STORE Proxy")
    print("="*60)
    print(f"Proxy: {PROXY_AET}@{PROXY_HOST}:{PROXY_PORT}")
    print()
    
    # Create AE
    ae = AE()
    
    # Test data directories
    test_dirs = [
        Path("testdata/DICOM-native/Leica-4"),
        Path("testdata/DICOM-native/3DHISTECH-1"),
        Path("testdata/DICOM-native/3DHISTECH-2"),
        Path("testdata/DICOM-native/CMU-1-JP2K-33005"),
        Path("testdata/DICOM-native/JP2K-33003-1"),
    ]
    
    total_success = 0
    total_failed = 0
    
    for test_dir in test_dirs:
        if test_dir.exists():
            print(f"\nUploading from {test_dir}:")
            success, failed = upload_directory(test_dir, ae)
            total_success += success
            total_failed += failed
        else:
            print(f"\nSkipping {test_dir} (not found)")
    
    # Also upload some test files from c_store_tests
    print("\nUploading test files:")
    test_files = [
        Path("c_store_tests/test_ct.dcm"),
        Path("c_store_tests/test_ct_image.dcm"),
    ]
    
    for test_file in test_files:
        if test_file.exists():
            if upload_dicom_file(test_file, ae):
                total_success += 1
            else:
                total_failed += 1
    
    print("\n" + "="*60)
    print("Upload Summary:")
    print(f"  ✓ Successful: {total_success}")
    print(f"  ✗ Failed: {total_failed}")
    print(f"  Total: {total_success + total_failed}")
    
    # Verify in Orthanc
    print("\nVerifying in Orthanc...")
    time.sleep(2)
    
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
