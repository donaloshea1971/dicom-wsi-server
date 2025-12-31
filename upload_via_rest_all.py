#!/usr/bin/env python3
"""Upload all test DICOM data via REST API (bypass C-STORE issues)"""

import sys
import time
import requests
from pathlib import Path
from pydicom import dcmread

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Configuration
ORTHANC_URL = "http://localhost:8042"
ORTHANC_USER = "admin"
ORTHANC_PASS = "orthanc"

def upload_file(file_path):
    """Upload a single DICOM file via REST API"""
    try:
        # Read file
        with open(file_path, 'rb') as f:
            dicom_data = f.read()
        
        # Get metadata
        ds = dcmread(file_path, force=True)
        patient_name = str(ds.get("PatientName", "Unknown"))
        modality = ds.get("Modality", "Unknown")
        transfer_syntax = ds.file_meta.get("TransferSyntaxUID", "1.2.840.10008.1.2") if hasattr(ds, 'file_meta') else "Unknown"
        
        print(f"  {file_path.name}")
        print(f"    Patient: {patient_name}")
        print(f"    Modality: {modality}")
        print(f"    Transfer Syntax: {transfer_syntax}")
        
        # Upload via REST API
        response = requests.post(
            f"{ORTHANC_URL}/instances",
            auth=(ORTHANC_USER, ORTHANC_PASS),
            data=dicom_data,
            headers={"Content-Type": "application/dicom"}
        )
        
        if response.status_code == 200:
            result = response.json()
            instance_id = result.get("ID", "Unknown")
            print(f"    ✓ SUCCESS (ID: {instance_id[:8]}...)")
            return True
        else:
            print(f"    ✗ Failed: HTTP {response.status_code}")
            return False
            
    except Exception as e:
        print(f"    ✗ Error: {str(e)[:100]}")
        return False

def main():
    print("="*70)
    print("Uploading All Test DICOM Data via REST API")
    print("="*70)
    print(f"Orthanc URL: {ORTHANC_URL}")
    print()
    
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
                if upload_file(file_path):
                    total_success += 1
                else:
                    total_failed += 1
                time.sleep(0.1)  # Small delay between uploads
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
            if upload_file(test_file):
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
    time.sleep(2)
    
    response = requests.get(f"{ORTHANC_URL}/statistics", auth=(ORTHANC_USER, ORTHANC_PASS))
    if response.status_code == 200:
        stats = response.json()
        print(f"  Studies: {stats.get('CountStudies', 0)}")
        print(f"  Series: {stats.get('CountSeries', 0)}")
        print(f"  Instances: {stats.get('CountInstances', 0)}")

if __name__ == "__main__":
    main()
