#!/usr/bin/env python3
"""Test the C-STORE proxy service"""

import sys
from pydicom import Dataset
from pydicom.uid import generate_uid, ImplicitVRLittleEndian
from pynetdicom import AE
from datetime import datetime

def test_proxy(host="localhost", port=4243):
    """Test C-STORE to proxy"""
    print(f"Testing C-STORE proxy at {host}:{port}")
    
    # Create test dataset
    ds = Dataset()
    ds.PatientName = f"PROXY^TEST^{datetime.now().strftime('%H%M%S')}"
    ds.PatientID = "PROXY123"
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture
    ds.SOPInstanceUID = generate_uid()
    ds.Modality = "OT"
    
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
    
    # Send to proxy
    ae = AE()
    ae.add_requested_context("1.2.840.10008.5.1.4.1.1.7")
    
    print(f"Connecting to CSTORE_PROXY@{host}:{port}")
    assoc = ae.associate(host, port, ae_title="CSTORE_PROXY")
    
    if assoc.is_established:
        print("Association established")
        status = assoc.send_c_store(ds)
        assoc.release()
        
        if status and status.Status == 0x0000:
            print(f"SUCCESS: File sent via proxy!")
            print(f"SOP Instance UID: {ds.SOPInstanceUID}")
            return True
        else:
            print(f"FAILED: Status = 0x{status.Status:04X}")
            return False
    else:
        print("FAILED: Association rejected")
        return False

if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 4243
    
    success = test_proxy(host, port)
    sys.exit(0 if success else 1)
