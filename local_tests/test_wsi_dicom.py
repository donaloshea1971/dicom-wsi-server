"""
Create a proper tiled WSI DICOM from iSyntax using wsidicom/highdicom

This creates multi-frame DICOM files with proper pyramid structure
that Orthanc's WSI plugin can recognize.
"""

import sys
from pathlib import Path
import os

# Change to project root
script_dir = Path(__file__).parent
os.chdir(script_dir.parent)

print("WSI DICOM Pyramid Generator Test")
print("=" * 60)
print(f"Working directory: {os.getcwd()}\n")


def test_with_wsidicomizer():
    """Try using wsidicomizer directly if it supports the format"""
    print("TEST: wsidicomizer direct open")
    print("-" * 40)
    
    try:
        from wsidicomizer import WsiDicomizer
        
        isyntax_path = "testdata/isyntax/testslide.isyntax"
        output_dir = Path("local_tests/output/wsidicomizer")
        output_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"Opening {isyntax_path}...")
        
        with WsiDicomizer.open(isyntax_path) as wsi:
            print(f"[OK] Opened with wsidicomizer!")
            print(f"  Levels: {wsi.levels}")
            
            print(f"\nSaving to {output_dir}...")
            wsi.save(str(output_dir))
            
            dcm_files = list(output_dir.glob("*.dcm"))
            print(f"[OK] Created {len(dcm_files)} DICOM files")
            for f in dcm_files:
                print(f"  - {f.name}: {f.stat().st_size / 1024 / 1024:.1f} MB")
            
            return True
            
    except Exception as e:
        print(f"[FAIL] wsidicomizer doesn't support iSyntax directly: {e}")
        return False


def test_with_highdicom():
    """Create WSI DICOM using highdicom"""
    print("\nTEST: highdicom tiled DICOM creation")
    print("-" * 40)
    
    try:
        from isyntax import ISyntax
        import highdicom as hd
        from highdicom.sr import CodedConcept
        import pydicom
        from pydicom.uid import generate_uid
        import numpy as np
        import datetime
        
        isyntax_path = "testdata/isyntax/testslide.isyntax"
        output_dir = Path("local_tests/output/highdicom")
        output_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"Opening {isyntax_path}...")
        
        with ISyntax.open(isyntax_path) as isyntax:
            width, height = isyntax.dimensions
            num_levels = isyntax.level_count
            tile_size = 256  # Use native tile size
            
            print(f"  Dimensions: {width}x{height}")
            print(f"  Levels: {num_levels}")
            print(f"  Tile size: {tile_size}")
            
            # For testing, just do level 4 (2336x4576 = ~10 MB uncompressed)
            test_level = 4
            level_obj = isyntax.wsi.get_level(test_level)
            lw, lh = level_obj.width, level_obj.height
            
            print(f"\nUsing level {test_level}: {lw}x{lh}")
            
            # Calculate tiles
            tiles_x = (lw + tile_size - 1) // tile_size
            tiles_y = (lh + tile_size - 1) // tile_size
            total_tiles = tiles_x * tiles_y
            
            print(f"  Tiles: {tiles_x} x {tiles_y} = {total_tiles}")
            
            # Read all tiles
            print(f"\nReading tiles...")
            frames = []
            for ty in range(tiles_y):
                for tx in range(tiles_x):
                    x = tx * tile_size
                    y = ty * tile_size
                    
                    # Read region, handling edges
                    read_w = min(tile_size, lw - x)
                    read_h = min(tile_size, lh - y)
                    
                    region = isyntax.read_region(x, y, read_w, read_h, level=test_level)
                    
                    # Convert RGBA to RGB
                    if region.shape[2] == 4:
                        region = region[:, :, :3]
                    
                    # Pad to tile_size if needed
                    if read_w < tile_size or read_h < tile_size:
                        padded = np.full((tile_size, tile_size, 3), 255, dtype=np.uint8)
                        padded[:read_h, :read_w, :] = region
                        region = padded
                    
                    frames.append(region)
                    
                    if len(frames) % 50 == 0:
                        print(f"  Read {len(frames)}/{total_tiles} tiles...")
            
            print(f"[OK] Read {len(frames)} tiles")
            
            # Stack frames
            pixel_array = np.stack(frames, axis=0)
            print(f"  Pixel array shape: {pixel_array.shape}")
            
            # Create DICOM dataset manually for WSI
            print("\nCreating tiled DICOM...")
            
            # This is a simplified approach - full implementation would need
            # proper Per Frame Functional Groups etc.
            
            ds = pydicom.Dataset()
            
            # SOP Common
            ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.77.1.6'  # VL Whole Slide Microscopy
            ds.SOPInstanceUID = generate_uid()
            
            # Patient
            ds.PatientName = 'TestSlide^iSyntax'
            ds.PatientID = 'ISYNTAX-WSI-TEST'
            ds.PatientBirthDate = ''
            ds.PatientSex = ''
            
            # Study
            ds.StudyInstanceUID = generate_uid()
            ds.StudyDate = datetime.datetime.now().strftime('%Y%m%d')
            ds.StudyTime = datetime.datetime.now().strftime('%H%M%S')
            ds.StudyDescription = 'iSyntax WSI Test'
            ds.AccessionNumber = ''
            ds.ReferringPhysicianName = ''
            
            # Series
            ds.SeriesInstanceUID = generate_uid()
            ds.SeriesNumber = 1
            ds.Modality = 'SM'
            ds.SeriesDescription = f'Level {test_level}'
            
            # Equipment
            ds.Manufacturer = 'Philips'
            ds.ManufacturerModelName = 'iSyntax (converted)'
            ds.DeviceSerialNumber = ''
            ds.SoftwareVersions = 'pyisyntax'
            
            # Image  
            ds.ImageType = ['DERIVED', 'PRIMARY', 'VOLUME', 'NONE']
            ds.InstanceNumber = 1
            ds.ContentDate = ds.StudyDate
            ds.ContentTime = ds.StudyTime
            
            # Pixel Data
            ds.SamplesPerPixel = 3
            ds.PhotometricInterpretation = 'RGB'
            ds.Rows = tile_size
            ds.Columns = tile_size
            ds.BitsAllocated = 8
            ds.BitsStored = 8
            ds.HighBit = 7
            ds.PixelRepresentation = 0
            ds.PlanarConfiguration = 0
            
            # WSI specific
            ds.TotalPixelMatrixColumns = lw
            ds.TotalPixelMatrixRows = lh
            ds.NumberOfFrames = total_tiles
            ds.TotalPixelMatrixFocalPlanes = 1
            ds.ImagedVolumeWidth = lw * 0.25 / 1000  # Assume 0.25 um/px, convert to mm
            ds.ImagedVolumeHeight = lh * 0.25 / 1000
            ds.ImagedVolumeDepth = 0.001
            
            # Per-Frame data would go here for proper WSI...
            # For now, just store the frames
            ds.PixelData = pixel_array.tobytes()
            
            # File Meta
            ds.file_meta = pydicom.Dataset()
            ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
            ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
            ds.file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
            
            output_file = output_dir / f"isyntax_level{test_level}.dcm"
            ds.save_as(str(output_file))
            
            print(f"[OK] Saved to {output_file}")
            print(f"  File size: {output_file.stat().st_size / 1024 / 1024:.1f} MB")
            
            return True
            
    except Exception as e:
        print(f"[FAIL] Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    # Try wsidicomizer first (unlikely to work for iSyntax)
    test_with_wsidicomizer()
    
    # Fall back to manual creation with highdicom concepts
    test_with_highdicom()
    
    print("\n" + "=" * 60)
    print("Check local_tests/output/ for generated files")


