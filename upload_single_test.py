#!/usr/bin/env python3
"""Upload a single test DICOM file"""

import sys
from pydicom import dcmread
from pynetdicom import AE, ALL_TRANSFER_SYNTAXES
from pynetdicom.sop_class import CTImageStorage

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def upload_test():
    """Upload test CT file"""
    file_path = "c_store_tests/test_ct.dcm"
    
    try:
        # Read file
        ds = dcmread(file_path, force=True)
        print(f"File: {file_path}")
        print(f"Patient: {ds.get('PatientName', 'Unknown')}")
        print(f"Modality: {ds.get('Modality', 'Unknown')}")
        print(f"Transfer Syntax: {ds.file_meta.TransferSyntaxUID}")
        
        # Create AE with proper transfer syntax support
        ae = AE()
        ae.add_requested_context(CTImageStorage, ALL_TRANSFER_SYNTAXES)
        
        # Connect to proxy
        print("\nConnecting to CSTORE_PROXY@localhost:4243...")
        assoc = ae.associate("localhost", 4243, ae_title="CSTORE_PROXY")
        
        if assoc.is_established:
            print("Association established")
            status = assoc.send_c_store(ds)
            assoc.release()
            
            if status and status.Status == 0x0000:
                print("✓ SUCCESS: File uploaded via proxy")
                return True
            else:
                print(f"✗ FAILED: Status 0x{status.Status:04X}")
                return False
        else:
            print("✗ FAILED: Association rejected")
            return False
            
    except Exception as e:
        print(f"✗ ERROR: {e}")
        return False

if __name__ == "__main__":
    upload_test()
