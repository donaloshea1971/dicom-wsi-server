import sys
import pydicom
from pynetdicom import AE, evt, debug_logger
from pynetdicom.sop_class import VLWholeSlideMicroscopyImageStorage

# Enable debug logging
debug_logger()

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def test_c_store_with_logging(file_path):
    """Test C-STORE with detailed logging"""
    
    # Load file
    ds = pydicom.dcmread(file_path)
    print(f"\nFile: {file_path}")
    print(f"SOP Class: {ds.SOPClassUID}")
    print(f"Transfer Syntax: {ds.file_meta.TransferSyntaxUID}")
    
    # Create AE
    ae = AE()
    ae.add_requested_context(VLWholeSlideMicroscopyImageStorage)
    
    # Associate
    print("\nConnecting to DIAGNEXIA@localhost:4242...")
    assoc = ae.associate('localhost', 4242, ae_title='DIAGNEXIA')
    
    if assoc.is_established:
        print("Association established")
        status = assoc.send_c_store(ds)
        print(f"C-STORE Status: {status}")
        assoc.release()
    else:
        print("Association rejected")

if __name__ == "__main__":
    # Test with smallest Leica file
    test_file = r"..\testdata\DICOM-native\Leica-4\1.3.6.1.4.1.36533.116129230228107214763613716719238114924751.dcm"
    test_c_store_with_logging(test_file)
