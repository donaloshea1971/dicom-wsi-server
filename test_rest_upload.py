#!/usr/bin/env python3
"""Test direct REST API upload to verify storage is working"""

import requests
import io
from pydicom import Dataset
from pydicom.uid import generate_uid, ImplicitVRLittleEndian
from datetime import datetime
import time

# Configuration
ORTHANC_URL = "http://localhost:8042"
ORTHANC_AUTH = ("admin", "orthanc")

def create_test_dicom():
    """Create a minimal test DICOM file"""
    ds = Dataset()
    
    # Patient
    ds.PatientName = f"REST^API^TEST^{datetime.now().strftime('%H%M%S')}"
    ds.PatientID = f"REST{int(time.time())}"
    
    # Study
    ds.StudyInstanceUID = generate_uid()
    ds.StudyDate = datetime.now().strftime("%Y%m%d")
    ds.StudyTime = datetime.now().strftime("%H%M%S")
    ds.StudyDescription = "REST API Upload Test"
    
    # Series
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 1
    ds.Modality = "OT"
    
    # Instance
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture
    ds.SOPInstanceUID = generate_uid()
    ds.InstanceNumber = 1
    
    # Minimal pixel data
    ds.Rows = 4
    ds.Columns = 4
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = bytes(range(16))
    
    # Transfer syntax
    ds.file_meta = Dataset()
    ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    
    return ds

def test_rest_upload():
    """Test uploading DICOM via REST API"""
    print("Testing REST API upload...")
    
    # Create test DICOM
    ds = create_test_dicom()
    sop_uid = ds.SOPInstanceUID
    patient_name = str(ds.PatientName)
    
    print(f"Created test DICOM:")
    print(f"  SOP Instance UID: {sop_uid}")
    print(f"  Patient Name: {patient_name}")
    
    # Save to bytes
    buffer = io.BytesIO()
    ds.save_as(buffer, write_like_original=False)
    dicom_bytes = buffer.getvalue()
    
    print(f"  File size: {len(dicom_bytes)} bytes")
    
    # Upload via REST API
    print("\nUploading to Orthanc via REST API...")
    try:
        response = requests.post(
            f"{ORTHANC_URL}/instances",
            auth=ORTHANC_AUTH,
            data=dicom_bytes,
            headers={"Content-Type": "application/dicom"}
        )
        
        print(f"Response status: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print("Upload successful!")
            print(f"  Instance ID: {result.get('ID', 'Unknown')}")
            print(f"  Status: {result.get('Status', 'Unknown')}")
            print(f"  Path: {result.get('Path', 'Unknown')}")
            
            instance_id = result.get('ID')
            if instance_id:
                # Verify instance exists
                print("\nVerifying instance...")
                verify_response = requests.get(
                    f"{ORTHANC_URL}/instances/{instance_id}",
                    auth=ORTHANC_AUTH
                )
                
                if verify_response.status_code == 200:
                    details = verify_response.json()
                    print("Instance verified!")
                    print(f"  Patient: {details['MainDicomTags'].get('PatientName', 'Unknown')}")
                    print(f"  Study: {details['MainDicomTags'].get('StudyDescription', 'Unknown')}")
                    print(f"  File size: {details.get('FileSize', 0)} bytes")
                    
                    # Try to download the file
                    file_response = requests.get(
                        f"{ORTHANC_URL}/instances/{instance_id}/file",
                        auth=ORTHANC_AUTH
                    )
                    if file_response.status_code == 200:
                        print(f"  File download successful ({len(file_response.content)} bytes)")
                    else:
                        print(f"  File download failed: {file_response.status_code}")
                else:
                    print(f"Verification failed: {verify_response.status_code}")
            
            return True
        else:
            print(f"Upload failed: {response.status_code}")
            print(f"Response: {response.text}")
            return False
            
    except Exception as e:
        print(f"Error: {e}")
        return False

def main():
    print("="*60)
    print("Orthanc REST API Upload Test")
    print("="*60)
    
    # Test connection
    try:
        response = requests.get(f"{ORTHANC_URL}/system", auth=ORTHANC_AUTH)
        if response.status_code == 200:
            info = response.json()
            print(f"Connected to Orthanc {info.get('Version', 'Unknown')}")
            print(f"Storage plugin: {info.get('StorageAreaPlugin', 'None')}")
            print()
        else:
            print(f"Cannot connect to Orthanc: {response.status_code}")
            return
    except Exception as e:
        print(f"Connection error: {e}")
        return
    
    # Test upload
    success = test_rest_upload()
    
    if success:
        print("\n✓ REST API upload is working correctly!")
    else:
        print("\n✗ REST API upload failed!")
        print("\nThis suggests a fundamental storage issue in Orthanc.")
        print("Check:")
        print("1. Disk space availability")
        print("2. Storage directory permissions")
        print("3. Orthanc error logs")

if __name__ == "__main__":
    main()
