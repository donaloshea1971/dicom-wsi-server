#!/usr/bin/env python3
"""
Simple C-STORE Client for External PACS Testing

A straightforward script to send DICOM files to Orthanc via C-STORE.
Can be used from external systems or for quick testing.

Usage:
    python simple_c_store_client.py <dicom_file> [options]
"""

import sys
import argparse
from pathlib import Path
from pydicom import dcmread
from pynetdicom import AE, StoragePresentationContexts
from pynetdicom.sop_class import VLWholeSlideMicroscopyImageStorage


def send_dicom_file(
    file_path: Path,
    server_host: str = "localhost",
    server_port: int = 4242,
    server_aet: str = "DIAGNEXIA",
    calling_aet: str = "EXTERNAL_PACS"
) -> bool:
    """
    Send a DICOM file via C-STORE
    
    Args:
        file_path: Path to DICOM file
        server_host: Target server hostname/IP
        server_port: Target server DICOM port
        server_aet: Target server AE Title
        calling_aet: This client's AE Title
    
    Returns:
        True if successful, False otherwise
    """
    print(f"Loading DICOM file: {file_path}")
    
    try:
        # Load DICOM file
        ds = dcmread(str(file_path))
        print(f"Patient: {ds.get('PatientName', 'Unknown')}")
        print(f"Study: {ds.get('StudyDescription', 'Unknown')}")
        print(f"Modality: {ds.get('Modality', 'Unknown')}")
        print(f"SOP Class: {ds.SOPClassUID}")
        
        # Create Application Entity
        ae = AE(ae_title=calling_aet)
        
        # Add all storage contexts
        ae.requested_contexts = StoragePresentationContexts
        
        # Ensure WSI context is included
        ae.add_requested_context(VLWholeSlideMicroscopyImageStorage)
        
        # Connect to server
        print(f"\nConnecting to {server_aet}@{server_host}:{server_port}...")
        assoc = ae.associate(server_host, server_port, ae_title=server_aet)
        
        if assoc.is_established:
            print("Association established")
            
            # Send C-STORE
            print("Sending C-STORE request...")
            status = assoc.send_c_store(ds)
            
            if status:
                if status.Status == 0x0000:
                    print(f"[SUCCESS] C-STORE successful!")
                    print(f"  SOP Instance UID: {ds.SOPInstanceUID}")
                    assoc.release()
                    return True
                else:
                    print(f"[FAILED] C-STORE failed with status: 0x{status.Status:04X}")
                    if hasattr(status, 'ErrorComment'):
                        print(f"  Error: {status.ErrorComment}")
            else:
                print("[FAILED] No status received")
            
            assoc.release()
            
        else:
            print("[FAILED] Association rejected")
            print("  Check server AE Title and network connectivity")
            
    except Exception as e:
        print(f"[ERROR] Error: {e}")
        return False
    
    return False


def main():
    parser = argparse.ArgumentParser(
        description="Send DICOM files to Orthanc via C-STORE",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Send to local Orthanc
    python simple_c_store_client.py image.dcm
    
    # Send to remote server
    python simple_c_store_client.py image.dcm --host 192.168.1.100
    
    # Send with custom AE Titles
    python simple_c_store_client.py image.dcm --server-aet ORTHANC --calling-aet MYWORKSTATION
    
    # Send multiple files
    python simple_c_store_client.py *.dcm
        """
    )
    
    parser.add_argument("files", nargs="+", type=Path, help="DICOM file(s) to send")
    parser.add_argument("--host", default="localhost", help="Server hostname/IP (default: localhost)")
    parser.add_argument("--port", type=int, default=4242, help="Server DICOM port (default: 4242)")
    parser.add_argument("--server-aet", default="DIAGNEXIA", help="Server AE Title (default: DIAGNEXIA)")
    parser.add_argument("--calling-aet", default="EXTERNAL_PACS", help="Calling AE Title (default: EXTERNAL_PACS)")
    
    args = parser.parse_args()
    
    # Process each file
    success_count = 0
    for file_path in args.files:
        if not file_path.exists():
            print(f"\n[ERROR] File not found: {file_path}")
            continue
        
        print(f"\n{'='*60}")
        if send_dicom_file(
            file_path,
            server_host=args.host,
            server_port=args.port,
            server_aet=args.server_aet,
            calling_aet=args.calling_aet
        ):
            success_count += 1
    
    # Summary
    print(f"\n{'='*60}")
    print(f"Summary: {success_count}/{len(args.files)} files sent successfully")
    
    return 0 if success_count == len(args.files) else 1


if __name__ == "__main__":
    sys.exit(main())
