#!/usr/bin/env python3
"""Test wsidicomizer DICOM generation for iSyntax - check all files"""
from wsidicomizer import WsiDicomizer
from pathlib import Path
import tempfile
from pydicom import dcmread

isyntax_path = '/app/testdata/isyntax/testslide.isyntax'
output_dir = tempfile.mkdtemp()

print('Converting iSyntax to DICOM...')
with WsiDicomizer.open(isyntax_path) as wsi:
    print(f'Image: {wsi.size.width}x{wsi.size.height}')
    wsi.save(output_dir)

print('\n=== Generated DICOM Files ===')
for f in sorted(Path(output_dir).glob('*.dcm'), key=lambda x: x.stat().st_size):
    size_mb = f.stat().st_size / (1024*1024)
    ds = dcmread(str(f), stop_before_pixels=True)
    
    frames = ds.get('NumberOfFrames', 1)
    img_type = ds.get('ImageType', [])
    rows = ds.Rows
    cols = ds.Columns
    
    print(f'\n{f.name}')
    print(f'  Size: {size_mb:.1f} MB')
    print(f'  Dimensions: {cols}x{rows}')
    print(f'  Frames: {frames}')
    print(f'  Image Type: {img_type}')
    
    # Check for tiled organization
    if hasattr(ds, 'TotalPixelMatrixColumns'):
        print(f'  Total Pixel Matrix: {ds.TotalPixelMatrixColumns}x{ds.TotalPixelMatrixRows}')
    
    # Check for dimension organization
    if hasattr(ds, 'DimensionOrganizationType'):
        print(f'  Dimension Organization: {ds.DimensionOrganizationType}')


