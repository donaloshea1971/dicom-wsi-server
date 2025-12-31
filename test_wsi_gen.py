#!/usr/bin/env python3
"""Test wsidicomizer DICOM generation for iSyntax"""
from wsidicomizer import WsiDicomizer
from pathlib import Path
import tempfile

isyntax_path = '/app/testdata/isyntax/testslide.isyntax'
output_dir = tempfile.mkdtemp()

print('Converting iSyntax to DICOM...')
with WsiDicomizer.open(isyntax_path) as wsi:
    print(f'Image: {wsi.size.width}x{wsi.size.height}')
    print('Saving to temp directory...')
    wsi.save(output_dir)

print('\nGenerated files:')
for f in Path(output_dir).glob('*'):
    size_mb = f.stat().st_size / (1024*1024)
    print(f'  {f.name}: {size_mb:.1f} MB')

from pydicom import dcmread
for f in Path(output_dir).glob('*.dcm'):
    ds = dcmread(str(f), stop_before_pixels=True)
    print(f'\nFile: {f.name}')
    print(f'  SOP Class: {ds.SOPClassUID}')
    print(f'  Rows x Cols: {ds.Rows}x{ds.Columns}')
    frames = ds.get('NumberOfFrames', 1)
    print(f'  Frame Count: {frames}')
    img_type = ds.get('ImageType', 'N/A')
    print(f'  Image Type: {img_type}')
    break


