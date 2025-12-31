import sys
import pydicom
from pynetdicom import AE, evt, debug_logger, build_context
from pynetdicom.sop_class import VLWholeSlideMicroscopyImageStorage
from pydicom.uid import (
    ImplicitVRLittleEndian,
    ExplicitVRLittleEndian,
    JPEGBaseline8Bit,
    JPEG2000Lossless,
    JPEGLSLossless,
    RLELossless
)

# Enable debug logging
debug_logger()

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def test_c_store_with_logging(file_path):
    """Test C-STORE with detailed logging and proper transfer syntax support"""
    
    # Load file
    ds = pydicom.dcmread(file_path)
    print(f"\nFile: {file_path}")
    print(f"SOP Class: {ds.SOPClassUID}")
    print(f"Transfer Syntax: {ds.file_meta.TransferSyntaxUID}")
    
    # Create AE
    ae = AE()
    
    # Build context with multiple transfer syntaxes including the one from the file
    transfer_syntaxes = [
        ImplicitVRLittleEndian,
        ExplicitVRLittleEndian,
        ds.file_meta.TransferSyntaxUID,  # Include the file's actual transfer syntax
        JPEGBaseline8Bit,
        JPEG2000Lossless,
        JPEGLSLossless,
        RLELossless
    ]
    # Remove duplicates while preserving order
    transfer_syntaxes = list(dict.fromkeys(transfer_syntaxes))
    
    # Add context with all transfer syntaxes
    for ts in transfer_syntaxes:
        ae.add_requested_context(ds.SOPClassUID, ts)
    
    # Associate
    print(f"\nConnecting to DIAGNEXIA@localhost:4242...")
    assoc = ae.associate('localhost', 4242, ae_title='DIAGNEXIA')
    
    if assoc.is_established:
        print("Association established")
        
        # Check accepted contexts
        print("\nAccepted contexts:")
        for cx in assoc.accepted_contexts:
            print(f"  {cx.abstract_syntax.name}")
            print(f"  Transfer Syntax: {cx.transfer_syntax[0].name}")
        
        try:
            status = assoc.send_c_store(ds)
            print(f"\nC-STORE Status: {status}")
            if status.Status == 0x0000:
                print("SUCCESS: File sent successfully!")
            else:
                print(f"FAILED: Status code 0x{status.Status:04X}")
        except Exception as e:
            print(f"ERROR during C-STORE: {e}")
        
        assoc.release()
    else:
        print("Association rejected")

if __name__ == "__main__":
    # Test with smallest Leica file
    test_file = r"..\testdata\DICOM-native\Leica-4\1.3.6.1.4.1.36533.116129230228107214763613716719238114924751.dcm"
    test_c_store_with_logging(test_file)
    
    # Also test with a simple generated file
    print("\n" + "="*60 + "\n")
    print("Testing with generated uncompressed file...")
    
    from pydicom import Dataset
    from pydicom.uid import generate_uid
    
    # Create simple test dataset
    ds = Dataset()
    ds.PatientName = "TEST^PATIENT"
    ds.PatientID = "12345"
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture
    ds.SOPInstanceUID = generate_uid()
    ds.Modality = "OT"
    ds.file_meta = Dataset()
    ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    
    # Simple 2x2 pixel data
    ds.Rows = 2
    ds.Columns = 2
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = b'\x00\x00' * 4
    
    # Send it
    ae = AE()
    ae.add_requested_context("1.2.840.10008.5.1.4.1.1.7")  # Secondary Capture
    
    assoc = ae.associate('localhost', 4242, ae_title='DIAGNEXIA')
    if assoc.is_established:
        print("Association established for test file")
        status = assoc.send_c_store(ds)
        if status.Status == 0x0000:
            print(f"SUCCESS: Test file sent! SOP Instance UID: {ds.SOPInstanceUID}")
        else:
            print(f"FAILED: Status code 0x{status.Status:04X}")
        assoc.release()
