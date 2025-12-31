#!/usr/bin/env python3
"""
Enhanced C-STORE client for WSI DICOM files with multiple transfer syntax support
"""

import sys
import os
from pathlib import Path
from pynetdicom import AE, evt, debug_logger
from pynetdicom.sop_class import (
    VLWholeSlideMicroscopyImageStorage,
    SecondaryCaptureImageStorage,
    CTImageStorage
)
from pydicom import dcmread
from pydicom.uid import (
    ImplicitVRLittleEndian,
    ExplicitVRLittleEndian,
    JPEG2000Lossless,
    JPEGLSLossless,
    RLELossless,
    ExplicitVRBigEndian
)

# Fix encoding for Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def send_wsi_dicom(file_path, host='localhost', port=4242, calling_aet='PYNETDICOM', called_aet='DIAGNEXIA'):
    """Send WSI DICOM file via C-STORE with multiple transfer syntax support"""
    
    # Load DICOM file
    try:
        ds = dcmread(file_path)
        print(f"\n{'='*60}")
        print(f"Loading DICOM file: {file_path}")
        print(f"Patient: {getattr(ds, 'PatientName', 'Unknown')}")
        print(f"Study: {getattr(ds, 'StudyDescription', 'Unknown')}")
        print(f"Modality: {getattr(ds, 'Modality', 'Unknown')}")
        print(f"SOP Class: {ds.SOPClassUID}")
        print(f"Transfer Syntax: {ds.file_meta.TransferSyntaxUID}")
        print(f"File size: {Path(file_path).stat().st_size / (1024*1024):.2f} MB")
    except Exception as e:
        print(f"[ERROR] Failed to read DICOM file: {e}")
        return False

    # Create AE with comprehensive transfer syntax support
    ae = AE(ae_title=calling_aet)
    
    # Define all possible transfer syntaxes for WSI
    transfer_syntaxes = [
        ImplicitVRLittleEndian,
        ExplicitVRLittleEndian,
        JPEG2000Lossless,
        JPEGLSLossless,
        RLELossless,
        ExplicitVRBigEndian,
        '1.2.840.10008.1.2.4.90',  # JPEG 2000 Part 1
        '1.2.840.10008.1.2.4.91',  # JPEG 2000 Part 2
        '1.2.840.10008.1.2.4.70',  # JPEG Lossless
        '1.2.840.10008.1.2.4.57',  # JPEG Lossless Process 14
        '1.2.840.10008.1.2.4.80',  # JPEG-LS Lossless
        '1.2.840.10008.1.2.4.81',  # JPEG-LS Near-lossless
    ]
    
    # Add the file's specific transfer syntax if not already in list
    if hasattr(ds.file_meta, 'TransferSyntaxUID') and ds.file_meta.TransferSyntaxUID not in transfer_syntaxes:
        transfer_syntaxes.insert(0, ds.file_meta.TransferSyntaxUID)
    
    # Add presentation contexts based on SOP Class
    if ds.SOPClassUID == VLWholeSlideMicroscopyImageStorage:
        for ts in transfer_syntaxes:
            ae.add_requested_context(VLWholeSlideMicroscopyImageStorage, ts)
    else:
        # Add generic contexts for other image types
        ae.add_requested_context(ds.SOPClassUID, transfer_syntaxes)
        ae.add_requested_context(SecondaryCaptureImageStorage, transfer_syntaxes)
    
    # Set timeouts for large files
    ae.network_timeout = 300  # 5 minutes
    ae.acse_timeout = 60
    ae.dimse_timeout = 300
    
    try:
        print(f"\nConnecting to {called_aet}@{host}:{port}...")
        assoc = ae.associate(host, port, ae_title=called_aet)
        
        if assoc.is_established:
            print("Association established")
            
            # Check which presentation context was accepted
            contexts = assoc.accepted_contexts
            print(f"Accepted contexts: {len(contexts)}")
            
            print("Sending C-STORE request...")
            status = assoc.send_c_store(ds)
            
            if status:
                print(f"[SUCCESS] C-STORE successful!")
                print(f"  SOP Instance UID: {ds.SOPInstanceUID}")
                success = True
            else:
                print(f"[ERROR] C-STORE failed with status: {status}")
                success = False
            
            assoc.release()
        else:
            print("[ERROR] Association rejected or aborted")
            if assoc.is_rejected:
                print(f"  Rejection reason: {assoc.rejection}")
            success = False
            
    except Exception as e:
        print(f"[ERROR] Error during C-STORE: {e}")
        success = False
    
    return success

def main():
    if len(sys.argv) < 2:
        print("Usage: python c_store_wsi_client.py <dicom_file> [host] [port] [calling_aet] [called_aet]")
        sys.exit(1)
    
    file_path = sys.argv[1]
    host = sys.argv[2] if len(sys.argv) > 2 else 'localhost'
    port = int(sys.argv[3]) if len(sys.argv) > 3 else 4242
    calling_aet = sys.argv[4] if len(sys.argv) > 4 else 'PYNETDICOM'
    called_aet = sys.argv[5] if len(sys.argv) > 5 else 'DIAGNEXIA'
    
    if not os.path.exists(file_path):
        print(f"[ERROR] File not found: {file_path}")
        sys.exit(1)
    
    success = send_wsi_dicom(file_path, host, port, calling_aet, called_aet)
    
    print(f"\n{'='*60}")
    print(f"Summary: {'SUCCESS' if success else 'FAILED'}")
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
