#!/usr/bin/env python3
"""Simple C-STORE test with one file"""

import sys
from pydicom import dcmread
from pynetdicom import AE, debug_logger
from pynetdicom.sop_class import CTImageStorage

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Enable debug logging
# debug_logger()

def test_simple_cstore():
    """Test simple C-STORE with CT image"""
    
    # Create test CT file if needed
    test_file = "c_store_tests/test_ct.dcm"
    
    # Read DICOM file
    ds = dcmread(test_file, force=True)
    print(f"File: {test_file}")
    print(f"Patient: {ds.get('PatientName', 'Unknown')}")
    print(f"Modality: {ds.get('Modality', 'Unknown')}")
    print(f"Transfer Syntax: {ds.file_meta.get('TransferSyntaxUID', '1.2.840.10008.1.2')}")
    
    # Create AE
    ae = AE()
    ae.add_requested_context(CTImageStorage)
    
    # Associate
    print(f"\nConnecting to CSTORE_PROXY@localhost:4243...")
    assoc = ae.associate('localhost', 4243, ae_title='CSTORE_PROXY')
    
    if assoc.is_established:
        print("✓ Association established")
        
        # Send C-STORE
        print("Sending C-STORE...")
        status = assoc.send_c_store(ds)
        
        if status and status.Status == 0x0000:
            print("✓ C-STORE successful")
        else:
            print(f"✗ C-STORE failed: Status 0x{status.Status:04X}")
            
        assoc.release()
        print("✓ Association released")
    else:
        print("✗ Association rejected")
        print(f"Rejected contexts: {assoc.rejected_contexts}")

if __name__ == "__main__":
    test_simple_cstore()
