#!/usr/bin/env python3
"""Test C-STORE proxy with all test data"""

import sys
import time
from pathlib import Path
from pydicom import dcmread
from pynetdicom import AE, ALL_TRANSFER_SYNTAXES, StoragePresentationContexts
from pynetdicom.sop_class import VLWholeSlideMicroscopyImageStorage

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

PROXY_HOST = "localhost"
PROXY_PORT = 4243
PROXY_AET = "CSTORE_PROXY"

def upload_file(file_path):
    """Upload a single DICOM file via C-STORE proxy"""
    try:
        # Read file
        ds = dcmread(file_path, force=True)
        
        # Get metadata
        patient = str(ds.get("PatientName", "Unknown"))
        modality = ds.get("Modality", "Unknown")
        transfer_syntax = ds.file_meta.get("TransferSyntaxUID", "1.2.840.10008.1.2")
        sop_class = ds.SOPClassUID
        
        print(f"\n  File: {file_path.name}")
        print(f"    Patient: {patient}")
        print(f"    Modality: {modality}")
        print(f"    Transfer Syntax: {transfer_syntax}")
        
        # Create AE with all transfer syntaxes
        ae = AE()
        # Add the specific SOP class with all transfer syntaxes
        ae.add_requested_context(sop_class, ALL_TRANSFER_SYNTAXES)
        
        # Connect and send
        assoc = ae.associate(PROXY_HOST, PROXY_PORT, ae_title=PROXY_AET)
        
        if assoc.is_established:
            status = assoc.send_c_store(ds)
            assoc.release()
            
            if status and status.Status == 0x0000:
                print("    ✓ SUCCESS")
                return True
            else:
                print(f"    ✗ FAILED: Status 0x{status.Status:04X}")
                return False
        else:
            print("    ✗ FAILED: Association rejected")
            return False
            
    except Exception as e:
        print(f"    ✗ ERROR: {e}")
        return False

def test_directory(dir_path, max_files=None):
    """Test all DICOM files in a directory"""
    success = 0
    failed = 0
    
    # Find DICOM files
    dcm_files = list(dir_path.glob("*.dcm"))
    if not dcm_files:
        # Try without extension
        dcm_files = [f for f in dir_path.iterdir() if f.is_file() and not f.name.startswith('.')]
    
    # Limit files if requested
    if max_files:
        dcm_files = dcm_files[:max_files]
    
    for file_path in dcm_files:
        if upload_file(file_path):
            success += 1
        else:
            failed += 1
        time.sleep(0.2)  # Small delay between uploads
    
    return success, failed

def main():
    print("="*60)
    print("Testing C-STORE Proxy with All Transfer Syntaxes")
    print("="*60)
    print(f"Proxy: {PROXY_AET}@{PROXY_HOST}:{PROXY_PORT}")
    
    # Test directories
    test_dirs = [
        ("Leica-4 (JPEG Baseline)", Path("testdata/DICOM-native/Leica-4"), 3),
        ("3DHISTECH-1 (JPEG Baseline)", Path("testdata/DICOM-native/3DHISTECH-1"), 3),
        ("3DHISTECH-2 (JPEG Baseline)", Path("testdata/DICOM-native/3DHISTECH-2"), 3),
        ("CMU-1-JP2K (JPEG 2000)", Path("testdata/DICOM-native/CMU-1-JP2K-33005"), 3),
        ("JP2K-33003 (JPEG 2000)", Path("testdata/DICOM-native/JP2K-33003-1"), 3),
    ]
    
    total_success = 0
    total_failed = 0
    
    for desc, dir_path, max_files in test_dirs:
        if dir_path.exists():
            print(f"\n{desc}:")
            success, failed = test_directory(dir_path, max_files)
            total_success += success
            total_failed += failed
        else:
            print(f"\nSkipping {desc} (not found)")
    
    # Also test some regular CT files
    print("\nRegular CT files:")
    ct_files = [
        Path("c_store_tests/test_ct.dcm"),
        Path("c_store_tests/test_ct_image.dcm"),
    ]
    
    for file_path in ct_files:
        if file_path.exists():
            if upload_file(file_path):
                total_success += 1
            else:
                total_failed += 1
    
    print("\n" + "="*60)
    print(f"Total Results:")
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
        print(f"\nOrthanc Statistics:")
        print(f"  Studies: {stats.get('CountStudies', 0)}")
        print(f"  Series: {stats.get('CountSeries', 0)}")
        print(f"  Instances: {stats.get('CountInstances', 0)}")
        print(f"  Total Size: {stats.get('TotalDiskSizeMB', 0)} MB")

if __name__ == "__main__":
    main()
