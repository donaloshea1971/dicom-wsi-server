#!/usr/bin/env python3
"""Upload missing WSI pyramid levels"""

import sys
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
        series_desc = str(ds.get("SeriesDescription", ""))
        rows = ds.get("Rows", 0)
        cols = ds.get("Columns", 0)
        
        print(f"  {file_path.name}")
        print(f"    Patient: {patient_name}")
        print(f"    Series: {series_desc}")
        print(f"    Size: {cols}x{rows}")
        
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
    print("Uploading Missing WSI Pyramid Levels")
    print("="*70)
    
    # Missing files from 3DHISTECH-2
    missing_files = ['2', '3', '4_1', '4_2', '5_0', '6_0', '7_0', '8_0', '9_0']
    base_dir = Path("testdata/DICOM-native/3DHISTECH-2")
    
    print(f"\nUploading missing files from {base_dir}:")
    
    total_success = 0
    total_failed = 0
    
    for filename in missing_files:
        file_path = base_dir / filename
        if file_path.exists():
            if upload_file(file_path):
                total_success += 1
            else:
                total_failed += 1
        else:
            print(f"  {filename}: File not found")
            total_failed += 1
    
    # Also upload ALL files from other multi-resolution datasets
    print("\nChecking other WSI datasets for completeness...")
    
    wsi_dirs = [
        ("Leica-4", Path("testdata/DICOM-native/Leica-4")),
        ("3DHISTECH-1", Path("testdata/DICOM-native/3DHISTECH-1")),
        ("CMU-1-JP2K-33005", Path("testdata/DICOM-native/CMU-1-JP2K-33005")),
        ("JP2K-33003-1", Path("testdata/DICOM-native/JP2K-33003-1")),
    ]
    
    for name, wsi_dir in wsi_dirs:
        if wsi_dir.exists():
            print(f"\n{name}:")
            files = list(wsi_dir.glob("*.dcm"))
            if not files:
                files = [f for f in wsi_dir.iterdir() if f.is_file() and not f.name.startswith('.')]
            
            # We already uploaded first 5, so skip them and upload rest
            if len(files) > 5:
                print(f"  Found {len(files)} total files, uploading remaining {len(files)-5}...")
                for file_path in files[5:]:
                    if upload_file(file_path):
                        total_success += 1
                    else:
                        total_failed += 1
            else:
                print(f"  All {len(files)} files already uploaded")
    
    print("\n" + "="*70)
    print(f"Upload Summary:")
    print(f"  ✓ Successful: {total_success}")
    print(f"  ✗ Failed: {total_failed}")
    print(f"  Total: {total_success + total_failed}")
    
    # Verify in Orthanc
    print("\nVerifying in Orthanc...")
    response = requests.get(f"{ORTHANC_URL}/statistics", auth=(ORTHANC_USER, ORTHANC_PASS))
    if response.status_code == 200:
        stats = response.json()
        print(f"  Studies: {stats.get('CountStudies', 0)}")
        print(f"  Series: {stats.get('CountSeries', 0)}")
        print(f"  Instances: {stats.get('CountInstances', 0)}")

if __name__ == "__main__":
    main()
