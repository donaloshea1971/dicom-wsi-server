#!/usr/bin/env python3
"""Test Orthanc storage configuration and C-STORE functionality"""

import sys
import requests
import json
import time
from pydicom import Dataset
from pydicom.uid import generate_uid, ImplicitVRLittleEndian
from pynetdicom import AE
from datetime import datetime

# Fix encoding for Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Configuration
ORTHANC_URL = "http://localhost:8042"
ORTHANC_AUTH = ("admin", "orthanc")
DICOM_PORT = 4242
DICOM_AET = "DIAGNEXIA"

def test_orthanc_connection():
    """Test Orthanc HTTP API connection"""
    print("Testing Orthanc connection...")
    try:
        response = requests.get(f"{ORTHANC_URL}/system", auth=ORTHANC_AUTH)
        if response.status_code == 200:
            info = response.json()
            print(f"✓ Connected to Orthanc {info.get('Version', 'Unknown')}")
            print(f"  - Storage: {info.get('StorageAreaPlugin', 'Built-in filesystem')}")
            print(f"  - Database: {info.get('DatabaseBackendPlugin', 'Built-in SQLite')}")
            print(f"  - DICOM AET: {info.get('DicomAet')}")
            print(f"  - DICOM Port: {info.get('DicomPort')}")
            return True
    except Exception as e:
        print(f"✗ Failed to connect: {e}")
    return False

def test_storage_info():
    """Get detailed storage information"""
    print("\nChecking storage configuration...")
    try:
        # Check statistics
        response = requests.get(f"{ORTHANC_URL}/statistics", auth=ORTHANC_AUTH)
        if response.status_code == 200:
            stats = response.json()
            print(f"✓ Storage statistics:")
            print(f"  - Total disk size: {stats.get('TotalDiskSize', 0):,} bytes")
            print(f"  - Total uncompressed size: {stats.get('TotalUncompressedSize', 0):,} bytes")
            print(f"  - Count patients: {stats.get('CountPatients', 0)}")
            print(f"  - Count studies: {stats.get('CountStudies', 0)}")
            print(f"  - Count series: {stats.get('CountSeries', 0)}")
            print(f"  - Count instances: {stats.get('CountInstances', 0)}")
            
        # Check configuration
        response = requests.get(f"{ORTHANC_URL}/tools/get-configuration", auth=ORTHANC_AUTH)
        if response.status_code == 200:
            config = response.json()
            print(f"\n✓ Storage configuration:")
            print(f"  - StoreDicom: {config.get('StoreDicom', 'Unknown')}")
            print(f"  - OverwriteInstances: {config.get('OverwriteInstances', 'Unknown')}")
            print(f"  - StorageDirectory: {config.get('StorageDirectory', 'Unknown')}")
            
            # Check PostgreSQL config
            pg_config = config.get('PostgreSQL', {})
            if pg_config:
                print(f"\n✓ PostgreSQL configuration:")
                print(f"  - EnableIndex: {pg_config.get('EnableIndex', False)}")
                print(f"  - EnableStorage: {pg_config.get('EnableStorage', False)}")
                print(f"  - Host: {pg_config.get('Host', 'Unknown')}")
                print(f"  - Database: {pg_config.get('Database', 'Unknown')}")
                
    except Exception as e:
        print(f"✗ Failed to get storage info: {e}")

def create_test_instance():
    """Create a minimal test DICOM instance"""
    ds = Dataset()
    
    # Patient
    ds.PatientName = f"TEST^STORAGE^{datetime.now().strftime('%H%M%S')}"
    ds.PatientID = f"PID{int(time.time())}"
    
    # Study
    ds.StudyInstanceUID = generate_uid()
    ds.StudyDate = datetime.now().strftime("%Y%m%d")
    ds.StudyTime = datetime.now().strftime("%H%M%S")
    ds.StudyDescription = "C-STORE Storage Test"
    
    # Series
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 1
    ds.Modality = "OT"
    
    # Instance
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture
    ds.SOPInstanceUID = generate_uid()
    ds.InstanceNumber = 1
    
    # Minimal pixel data
    ds.Rows = 2
    ds.Columns = 2
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = b'\x00\xFF\xFF\x00'
    
    # Transfer syntax
    ds.file_meta = Dataset()
    ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    
    return ds

def test_c_store_and_verify():
    """Test C-STORE and verify storage"""
    print("\nTesting C-STORE with verification...")
    
    # Create test instance
    ds = create_test_instance()
    sop_uid = ds.SOPInstanceUID
    patient_name = str(ds.PatientName)
    
    print(f"Created test instance:")
    print(f"  - SOP Instance UID: {sop_uid}")
    print(f"  - Patient Name: {patient_name}")
    
    # Send via C-STORE
    print(f"\nSending to {DICOM_AET}@localhost:{DICOM_PORT}...")
    ae = AE()
    ae.add_requested_context("1.2.840.10008.5.1.4.1.1.7")  # Secondary Capture
    
    assoc = ae.associate("localhost", DICOM_PORT, ae_title=DICOM_AET)
    if assoc.is_established:
        print("✓ Association established")
        status = assoc.send_c_store(ds)
        assoc.release()
        
        if status and status.Status == 0x0000:
            print("✓ C-STORE successful")
            
            # Wait a moment for processing
            print("\nWaiting for Orthanc to process...")
            time.sleep(2)
            
            # Verify via REST API
            print("\nVerifying storage via REST API...")
            
            # Method 1: Search by SOP Instance UID
            search_data = {
                "Level": "Instance",
                "Query": {
                    "SOPInstanceUID": sop_uid
                }
            }
            response = requests.post(
                f"{ORTHANC_URL}/tools/find",
                auth=ORTHANC_AUTH,
                json=search_data
            )
            
            if response.status_code == 200:
                instances = response.json()
                if instances:
                    instance_id = instances[0]
                    print(f"✓ Instance found in database: {instance_id}")
                    
                    # Get instance details
                    response = requests.get(
                        f"{ORTHANC_URL}/instances/{instance_id}",
                        auth=ORTHANC_AUTH
                    )
                    if response.status_code == 200:
                        details = response.json()
                        print(f"✓ Instance details retrieved:")
                        print(f"  - Patient: {details['MainDicomTags'].get('PatientName')}")
                        print(f"  - Study: {details['MainDicomTags'].get('StudyDescription')}")
                        print(f"  - File size: {details.get('FileSize', 0):,} bytes")
                        
                        # Check if file is actually stored
                        file_response = requests.get(
                            f"{ORTHANC_URL}/instances/{instance_id}/file",
                            auth=ORTHANC_AUTH
                        )
                        if file_response.status_code == 200:
                            print(f"✓ DICOM file is accessible ({len(file_response.content):,} bytes)")
                            return True
                        else:
                            print(f"✗ Cannot retrieve DICOM file: {file_response.status_code}")
                else:
                    print("✗ Instance not found in database")
                    
                    # Try alternative search
                    print("\nTrying patient-level search...")
                    search_data = {
                        "Level": "Patient",
                        "Query": {
                            "PatientName": patient_name
                        }
                    }
                    response = requests.post(
                        f"{ORTHANC_URL}/tools/find",
                        auth=ORTHANC_AUTH,
                        json=search_data
                    )
                    if response.status_code == 200:
                        patients = response.json()
                        print(f"Found {len(patients)} patients with name '{patient_name}'")
            else:
                print(f"✗ Search failed: {response.status_code}")
        else:
            print(f"✗ C-STORE failed: {status}")
    else:
        print("✗ Association rejected")
    
    return False

def check_recent_instances():
    """Check recently stored instances"""
    print("\nChecking recent instances...")
    try:
        response = requests.get(f"{ORTHANC_URL}/instances?limit=5&since=0", auth=ORTHANC_AUTH)
        if response.status_code == 200:
            instances = response.json()
            print(f"Found {len(instances)} recent instances")
            
            for inst_id in instances[:3]:  # Check first 3
                response = requests.get(f"{ORTHANC_URL}/instances/{inst_id}", auth=ORTHANC_AUTH)
                if response.status_code == 200:
                    details = response.json()
                    print(f"\nInstance {inst_id}:")
                    print(f"  - Patient: {details['MainDicomTags'].get('PatientName', 'Unknown')}")
                    print(f"  - Date: {details['MainDicomTags'].get('StudyDate', 'Unknown')}")
                    print(f"  - Modality: {details['MainDicomTags'].get('Modality', 'Unknown')}")
    except Exception as e:
        print(f"✗ Failed to check instances: {e}")

def main():
    """Run all tests"""
    print("="*60)
    print("Orthanc Storage Configuration Test")
    print("="*60)
    
    if not test_orthanc_connection():
        print("\n✗ Cannot connect to Orthanc. Is it running?")
        return
    
    test_storage_info()
    
    success = test_c_store_and_verify()
    
    if not success:
        print("\n" + "="*60)
        print("TROUBLESHOOTING")
        print("="*60)
        check_recent_instances()
        
        print("\nPossible issues:")
        print("1. Check if 'StoreDicom' is set to true in Orthanc config")
        print("2. Verify PostgreSQL storage plugin is properly configured")
        print("3. Check Orthanc logs: docker logs dicom-orthanc")
        print("4. Ensure sufficient disk space")
        print("5. Check if any Lua scripts are filtering C-STORE")
    else:
        print("\n✓ All tests passed! C-STORE is working correctly.")

if __name__ == "__main__":
    main()
