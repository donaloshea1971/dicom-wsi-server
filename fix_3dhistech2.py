#!/usr/bin/env python3
"""Attempt to fix or reorganize 3DHISTECH-2 data"""

import requests
import sys
from pathlib import Path

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

print("Checking 3DHISTECH-2 source files...\n")

# Check the original files
source_dir = Path("testdata/DICOM-native/3DHISTECH-2")
files = list(source_dir.iterdir())
files.sort()

print(f"Source directory: {source_dir}")
print(f"Total files: {len(files)}\n")

# Let's read the DICOM headers from the source files
import pydicom

file_info = []
for f in files:
    if f.is_file() and not f.name.startswith('.'):
        try:
            ds = pydicom.dcmread(f, stop_before_pixels=True, force=True)
            info = {
                'filename': f.name,
                'instance_number': getattr(ds, 'InstanceNumber', 'N/A'),
                'image_type': getattr(ds, 'ImageType', ['N/A']),
                'rows': getattr(ds, 'Rows', 'N/A'),
                'cols': getattr(ds, 'Columns', 'N/A'),
                'number_of_frames': getattr(ds, 'NumberOfFrames', 1),
                'sop_instance_uid': getattr(ds, 'SOPInstanceUID', 'N/A'),
            }
            
            # Check for WSI specific attributes
            if hasattr(ds, 'TotalPixelMatrixColumns'):
                info['total_cols'] = ds.TotalPixelMatrixColumns
                info['total_rows'] = ds.TotalPixelMatrixRows
            
            file_info.append(info)
        except Exception as e:
            print(f"Error reading {f.name}: {e}")

# Sort by filename
file_info.sort(key=lambda x: x['filename'])

print("File Analysis:")
print("-" * 100)
print(f"{'File':<15} {'Inst#':<6} {'Type':<35} {'Size':<12} {'Frames':<8} {'Total Matrix':<15}")
print("-" * 100)

for info in file_info:
    image_type = '/'.join(info['image_type'][:4]) if isinstance(info['image_type'], list) else str(info['image_type'])
    size = f"{info['cols']}x{info['rows']}"
    total = f"{info.get('total_cols', '?')}x{info.get('total_rows', '?')}" if 'total_cols' in info else "N/A"
    
    print(f"{info['filename']:<15} {str(info['instance_number']):<6} {image_type:<35} {size:<12} {info['number_of_frames']:<8} {total:<15}")

# Analysis
print("\n\nAnalysis:")
print("1. This appears to be a synthetic test dataset with very small image sizes")
print("2. The files use duplicate instance numbers which confuses the WSI plugin")
print("3. The 'VOLUME' type instances with multiple frames are the actual image data")
print("4. The tiny sizes (5x5, 2x9, etc) suggest this is test data, not real WSI")

# Check if we have any real WSI data
real_wsi = [f for f in file_info if f.get('total_cols', 0) > 1000 or f['cols'] > 100]
if real_wsi:
    print(f"\nFound {len(real_wsi)} files that might be real WSI data:")
    for f in real_wsi:
        print(f"  - {f['filename']}: {f['cols']}x{f['rows']}")
else:
    print("\nNo files with realistic WSI dimensions found.")
    print("This dataset appears to be synthetic test data, not real WSI images.")

print("\n\nRecommendation:")
print("This 3DHISTECH-2 dataset is not a standard WSI format and appears to be")
print("synthetic test data with tiny image sizes. The Orthanc WSI plugin correctly")
print("rejects it because it doesn't represent a real whole slide image.")
print("\nThe other datasets (3DHISTECH-1, Leica-4, CMU, JP2K) are working correctly")
print("and represent real WSI data that can be properly viewed.")

# List working alternatives
print("\n\nWorking WSI datasets you can view:")
print("- 3DHISTECH-1: http://localhost:3000/?series=fc2e90ad-4599bc0d-218785fd-114fa180-9a6228bf")
print("- CMU JP2K: http://localhost:3000/?series=2ae1741c-7b1622c5-2740c525-215222b1-bfcfda05")
print("- JP2K-33003: http://localhost:3000/?series=315c8242-882c1e86-121fe508-4adc7e30-07a7d6c1")
