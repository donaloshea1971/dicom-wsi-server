#!/usr/bin/env python3
"""Upload DICOM files via REST API (bypassing C-STORE issues)"""

import sys
import requests
from pathlib import Path
from pydicom import dcmread

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
ORTHANC_AUTH = ("admin", "orthanc")

def upload_file(file_path):
    """Upload file via REST API"""
    try:
        # Read file
        ds = dcmread(file_path, force=True)
        patient = str(ds.get("PatientName", "Unknown"))
        modality = ds.get("Modality", "Unknown")
        
        print(f"Uploading: {patient} ({modality}) - {file_path.name}")
        
        # Read file bytes
        with open(file_path, 'rb') as f:
            dicom_bytes = f.read()
        
        # Upload
        response = requests.post(
            f"{ORTHANC_URL}/instances",
            auth=ORTHANC_AUTH,
            data=dicom_bytes,
            headers={"Content-Type": "application/dicom"}
        )
        
        if response.status_code == 200:
            print("  ✓ Success")
            return True
        else:
            print(f"  ✗ Failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"  ✗ Error: {e}")
        return False

def main():
    print("Uploading test data via REST API...")
    print("="*50)
    
    # Upload some test files
    test_files = [
        # Some 3DHISTECH files
        Path("testdata/DICOM-native/3DHISTECH-1/000001.dcm"),
        Path("testdata/DICOM-native/3DHISTECH-1/000002.dcm"),
        Path("testdata/DICOM-native/3DHISTECH-1/000003.dcm"),
        # Some 3DHISTECH-2 files
        Path("testdata/DICOM-native/3DHISTECH-2/2"),
        Path("testdata/DICOM-native/3DHISTECH-2/3"),
        # Some JP2K files
        Path("testdata/DICOM-native/JP2K-33003-1/DCM_0.dcm"),
        Path("testdata/DICOM-native/JP2K-33003-1/DCM_1.dcm"),
    ]
    
    success = 0
    for file_path in test_files:
        if file_path.exists():
            if upload_file(file_path):
                success += 1
        else:
            print(f"Skipping {file_path} (not found)")
    
    print(f"\n✓ Uploaded {success} files successfully")
    
    # Check final stats
    response = requests.get(f"{ORTHANC_URL}/statistics", auth=ORTHANC_AUTH)
    if response.status_code == 200:
        stats = response.json()
        print(f"\nOrthanc now contains:")
        print(f"  Studies: {stats.get('CountStudies', 0)}")
        print(f"  Series: {stats.get('CountSeries', 0)}")
        print(f"  Instances: {stats.get('CountInstances', 0)}")

if __name__ == "__main__":
    main()
