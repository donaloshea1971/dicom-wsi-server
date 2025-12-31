#!/usr/bin/env python3
"""Upload WSI DICOM files with proper transfer syntax support"""

import sys
import os
from pathlib import Path
from pydicom import dcmread
from pynetdicom import AE, ALL_TRANSFER_SYNTAXES, StoragePresentationContexts
from pynetdicom.sop_class import VLWholeSlideMicroscopyImageStorage

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def upload_file(file_path, ae):
    """Upload a single DICOM file"""
    try:
        # Read file
        ds = dcmread(file_path, force=True)
        
        # Get info
        patient = str(ds.get("PatientName", "Unknown"))
        modality = ds.get("Modality", "Unknown")
        sop_class = ds.SOPClassUID
        transfer_syntax = ds.file_meta.get("TransferSyntaxUID", "1.2.840.10008.1.2")
        
        print(f"\nFile: {file_path.name}")
        print(f"  Patient: {patient}")
        print(f"  Modality: {modality}")
        print(f"  Transfer Syntax: {transfer_syntax}")
        
        # Associate
        assoc = ae.associate("localhost", 4243, ae_title="CSTORE_PROXY")
        
        if assoc.is_established:
            # Send
            status = assoc.send_c_store(ds)
            assoc.release()
            
            if status and status.Status == 0x0000:
                print("  ✓ SUCCESS")
                return True
            else:
                print(f"  ✗ FAILED: Status 0x{status.Status:04X}")
                return False
        else:
            print("  ✗ FAILED: Association rejected")
            return False
            
    except Exception as e:
        print(f"  ✗ ERROR: {e}")
        return False

def main():
    print("="*60)
    print("Uploading WSI DICOM Files")
    print("="*60)
    
    # Create AE with ALL transfer syntaxes
    ae = AE()
    
    # Add all storage contexts with all transfer syntaxes
    for context in StoragePresentationContexts:
        ae.add_requested_context(context.abstract_syntax, ALL_TRANSFER_SYNTAXES)
    
    # Ensure WSI is supported
    ae.add_requested_context(VLWholeSlideMicroscopyImageStorage, ALL_TRANSFER_SYNTAXES)
    
    # Test directories
    dirs = [
        Path("testdata/DICOM-native/Leica-4"),
        Path("testdata/DICOM-native/3DHISTECH-1"),
        Path("testdata/DICOM-native/CMU-1-JP2K-33005"),
    ]
    
    total_success = 0
    total_failed = 0
    
    for dir_path in dirs:
        if dir_path.exists():
            print(f"\nProcessing {dir_path}:")
            
            # Get DICOM files
            dcm_files = list(dir_path.glob("*.dcm"))
            if not dcm_files:
                # Try without extension
                dcm_files = [f for f in dir_path.iterdir() if f.is_file() and not f.name.startswith('.')]
            
            # Upload each file
            for file_path in dcm_files[:3]:  # Limit to 3 files per directory for testing
                if upload_file(file_path, ae):
                    total_success += 1
                else:
                    total_failed += 1
    
    print("\n" + "="*60)
    print(f"Summary: {total_success} successful, {total_failed} failed")
    
    # Check Orthanc
    import requests
    import time
    time.sleep(2)
    
    auth = ("admin", "orthanc")
    response = requests.get("http://localhost:8042/statistics", auth=auth)
    if response.status_code == 200:
        stats = response.json()
        print(f"\nOrthanc now has:")
        print(f"  Studies: {stats.get('CountStudies', 0)}")
        print(f"  Series: {stats.get('CountSeries', 0)}")
        print(f"  Instances: {stats.get('CountInstances', 0)}")

if __name__ == "__main__":
    main()
