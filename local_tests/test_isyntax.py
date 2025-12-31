"""
Local test script for Philips iSyntax conversion to DICOM WSI

This tests the conversion pipeline offline before Docker integration.
"""

import sys
from pathlib import Path

# Test 1: Can we open the iSyntax file?
def test_open_isyntax():
    print("=" * 60)
    print("TEST 1: Opening iSyntax file")
    print("=" * 60)
    
    isyntax_path = Path("testdata/isyntax/testslide.isyntax")
    
    if not isyntax_path.exists():
        print(f"ERROR: File not found: {isyntax_path}")
        return False
    
    print(f"File size: {isyntax_path.stat().st_size / 1024 / 1024:.1f} MB")
    
    try:
        from isyntax import ISyntax
        
        with ISyntax.open(str(isyntax_path)) as isyntax:
            width, height = isyntax.dimensions
            num_levels = isyntax.level_count
            
            print(f"[OK] Opened successfully!")
            print(f"  Dimensions: {width} x {height}")
            print(f"  Pyramid levels: {num_levels}")
            
            # Check each level
            print("\n  Level details:")
            for level in range(num_levels):
                level_obj = isyntax.wsi.get_level(level)
                lw, lh = level_obj.width, level_obj.height
                scale = width / lw
                print(f"    Level {level}: {lw} x {lh} (scale: {scale:.1f}x)")
            
            return True
            
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False


# Test 2: Can we read pixel data?
def test_read_pixels():
    print("\n" + "=" * 60)
    print("TEST 2: Reading pixel data")
    print("=" * 60)
    
    isyntax_path = Path("testdata/isyntax/testslide.isyntax")
    
    try:
        from isyntax import ISyntax
        import numpy as np
        
        with ISyntax.open(str(isyntax_path)) as isyntax:
            # Read a small region from level 0
            print("Reading 512x512 region from level 0...")
            pixels = isyntax.read_region(0, 0, 512, 512, level=0)
            
            print(f"[OK] Read successfully!")
            print(f"  Shape: {pixels.shape}")
            print(f"  Dtype: {pixels.dtype}")
            print(f"  Min/Max: {pixels.min()} / {pixels.max()}")
            
            # Try reading from a lower resolution level
            num_levels = isyntax.level_count
            mid_level = num_levels // 2
            level_obj = isyntax.wsi.get_level(mid_level)
            
            print(f"\nReading full image from level {mid_level} ({level_obj.width}x{level_obj.height})...")
            pixels = isyntax.read_region(0, 0, level_obj.width, level_obj.height, level=mid_level)
            
            print(f"[OK] Read successfully!")
            print(f"  Shape: {pixels.shape}")
            
            return True
            
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False


# Test 3: Check tile access
def test_tiles():
    print("\n" + "=" * 60)
    print("TEST 3: Checking tile access")
    print("=" * 60)
    
    isyntax_path = Path("testdata/isyntax/testslide.isyntax")
    
    try:
        from isyntax import ISyntax
        
        with ISyntax.open(str(isyntax_path)) as isyntax:
            # Check if tile properties are available
            if hasattr(isyntax, 'tile_width'):
                print(f"Tile size: {isyntax.tile_width} x {isyntax.tile_height}")
            else:
                print("Note: tile_width/tile_height not directly available")
                print("Will need to use fixed tile size (e.g., 512)")
            
            # Try read_tile if available
            if hasattr(isyntax, 'read_tile'):
                print("\nTrying read_tile(0, 0, level=0)...")
                tile = isyntax.read_tile(0, 0, level=0)
                print(f"[OK] Tile shape: {tile.shape}")
            else:
                print("Note: read_tile not available, will use read_region")
            
            return True
            
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False


# Test 4: Create simple DICOM
def test_create_dicom():
    print("\n" + "=" * 60)
    print("TEST 4: Creating DICOM file")
    print("=" * 60)
    
    isyntax_path = Path("testdata/isyntax/testslide.isyntax")
    output_dir = Path("local_tests/output")
    output_dir.mkdir(exist_ok=True)
    
    try:
        from isyntax import ISyntax
        import pydicom
        from pydicom.uid import generate_uid
        import datetime
        
        with ISyntax.open(str(isyntax_path)) as isyntax:
            # Use a mid-resolution level
            num_levels = isyntax.level_count
            level = min(4, num_levels - 1)
            level_obj = isyntax.wsi.get_level(level)
            
            print(f"Reading level {level} ({level_obj.width}x{level_obj.height})...")
            pixels = isyntax.read_region(0, 0, level_obj.width, level_obj.height, level=level)
            
            print(f"Creating DICOM dataset...")
            
            ds = pydicom.Dataset()
            ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.77.1.6'
            ds.SOPInstanceUID = generate_uid()
            ds.StudyInstanceUID = generate_uid()
            ds.SeriesInstanceUID = generate_uid()
            ds.PatientName = 'TestSlide'
            ds.PatientID = 'ISYNTAX-TEST'
            ds.StudyDate = datetime.datetime.now().strftime('%Y%m%d')
            ds.StudyTime = datetime.datetime.now().strftime('%H%M%S')
            ds.Modality = 'SM'
            ds.Manufacturer = 'Philips (pyisyntax)'
            ds.SamplesPerPixel = 3
            ds.PhotometricInterpretation = 'RGB'
            ds.Rows = pixels.shape[0]
            ds.Columns = pixels.shape[1]
            ds.BitsAllocated = 8
            ds.BitsStored = 8
            ds.HighBit = 7
            ds.PixelRepresentation = 0
            ds.PlanarConfiguration = 0
            
            # Handle RGBA -> RGB
            if pixels.shape[2] == 4:
                pixels = pixels[:, :, :3]
            ds.PixelData = pixels.tobytes()
            
            ds.file_meta = pydicom.Dataset()
            ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
            ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
            ds.file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
            
            output_file = output_dir / "test_isyntax.dcm"
            ds.save_as(str(output_file))
            
            print(f"[OK] Saved to: {output_file}")
            print(f"  File size: {output_file.stat().st_size / 1024 / 1024:.1f} MB")
            
            return True
            
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install with: pip install pydicom")
        return False
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    print("Philips iSyntax Conversion Test Suite")
    print("=" * 60)
    
    # Change to project root
    import os
    script_dir = Path(__file__).parent
    os.chdir(script_dir.parent)
    print(f"Working directory: {os.getcwd()}\n")
    
    results = []
    
    results.append(("Open iSyntax", test_open_isyntax()))
    results.append(("Read Pixels", test_read_pixels()))
    results.append(("Tile Access", test_tiles()))
    results.append(("Create DICOM", test_create_dicom()))
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for name, passed in results:
        status = "[OK] PASS" if passed else "[FAIL] FAIL"
        print(f"  {name}: {status}")

