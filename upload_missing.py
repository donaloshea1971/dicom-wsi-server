#!/usr/bin/env python3
"""Upload missing native DICOM test data"""
import requests
import sys
from pathlib import Path

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
AUTH = ('admin', 'orthanc')

def upload_dicom(file_path):
    """Upload a single DICOM file to Orthanc"""
    with open(file_path, 'rb') as f:
        response = requests.post(
            f"{ORTHANC_URL}/instances",
            data=f.read(),
            headers={'Content-Type': 'application/dicom'},
            auth=AUTH
        )
    return response.status_code in [200, 201]

def upload_folder(folder_path):
    """Upload all DICOM files in a folder"""
    folder = Path(folder_path)
    files = list(folder.glob('*.dcm')) + list(folder.glob('1.*'))  # Include Leica UID-named files
    
    # Also include files without extension (like 3DHISTECH-2)
    for f in folder.iterdir():
        if f.is_file() and not f.suffix and f.name != 'DICOMDIR':
            files.append(f)
    
    print(f"\n{folder.name}: {len(files)} files")
    
    success = 0
    for f in files:
        if upload_dicom(f):
            success += 1
            print(f"  ✓ {f.name}")
        else:
            print(f"  ✗ {f.name}")
    
    return success, len(files)

# Datasets to upload
datasets = [
    "testdata/DICOM-native/CMU-1-JP2K-33005",
    "testdata/DICOM-native/JP2K-33003-1",
    "testdata/DICOM-native/Leica-4",
]

print("=" * 60)
print("Uploading missing test data...")
print("=" * 60)

total_success = 0
total_files = 0

for dataset in datasets:
    path = Path(dataset)
    if path.exists():
        s, t = upload_folder(path)
        total_success += s
        total_files += t
    else:
        print(f"\n⚠ Dataset not found: {dataset}")

print("\n" + "=" * 60)
print(f"Uploaded: {total_success}/{total_files} files")
print("=" * 60)

