#!/usr/bin/env python3
"""Check source Sierra DICOM file for ICC profile"""
import pydicom
from pathlib import Path

sierra_dir = Path('testdata/Sierra-ICC_Scan_Trichrome_kidney3')
dcm_files = list(sierra_dir.glob('*.dcm'))

if dcm_files:
    ds = pydicom.dcmread(str(dcm_files[0]), force=True)
    
    print('Sierra Source DICOM ICC Analysis:')
    print('=' * 50)
    print(f'File: {dcm_files[0].name}')
    print(f'Manufacturer: {getattr(ds, "Manufacturer", "N/A")}')
    print(f'Model: {getattr(ds, "ManufacturerModelName", "N/A")}')
    print()
    
    # Check top-level ICC
    if hasattr(ds, 'ICCProfile') and ds.ICCProfile:
        print(f'Top-level ICC Profile: {len(ds.ICCProfile)} bytes')
    else:
        print('Top-level ICC Profile: Not present or empty')
    
    # Check OpticalPathSequence
    if hasattr(ds, 'OpticalPathSequence'):
        print(f'OpticalPathSequence: {len(ds.OpticalPathSequence)} items')
        for i, item in enumerate(ds.OpticalPathSequence):
            print(f'  Item[{i}]:')
            
            # Check for ICC Profile
            icc_data = getattr(item, 'ICCProfile', None)
            if icc_data is not None and len(icc_data) > 0:
                print(f'    ICC Profile: {len(icc_data)} bytes')
                # Show header to identify profile type
                header = bytes(icc_data[:32])
                print(f'    Header hex: {header.hex()[:64]}...')
                
                # Try to identify profile
                if len(icc_data) >= 128:
                    profile_size = int.from_bytes(icc_data[0:4], 'big')
                    color_space = icc_data[16:20].decode('ascii', errors='replace')
                    print(f'    Profile size: {profile_size} bytes')
                    print(f'    Color space: {color_space}')
            elif icc_data is not None:
                print(f'    ICC Profile: Present but empty (length 0)')
            else:
                print(f'    ICC Profile: Not present in sequence item')
            
            # Show other optical path attributes
            if hasattr(item, 'OpticalPathIdentifier'):
                print(f'    OpticalPathIdentifier: {item.OpticalPathIdentifier}')
    else:
        print('OpticalPathSequence: Not present')
        
    # Check PhotometricInterpretation
    print()
    print(f'PhotometricInterpretation: {getattr(ds, "PhotometricInterpretation", "N/A")}')
    print(f'SamplesPerPixel: {getattr(ds, "SamplesPerPixel", "N/A")}')
    print(f'BitsStored: {getattr(ds, "BitsStored", "N/A")}')
else:
    print('No DICOM files found in Sierra directory')

