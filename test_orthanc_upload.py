#!/usr/bin/env python3
"""Test direct upload to Orthanc"""
from wsidicomizer import WsiDicomizer
from pathlib import Path
import tempfile
import requests

isyntax_path = '/app/testdata/isyntax/testslide.isyntax'
output_dir = tempfile.mkdtemp()

print('Converting iSyntax to DICOM...')
with WsiDicomizer.open(isyntax_path) as wsi:
    print(f'Image: {wsi.size.width}x{wsi.size.height}')
    wsi.save(output_dir)

print('\n=== Uploading to Orthanc ===')
orthanc_url = 'http://orthanc:8042'
auth = ('admin', 'orthanc')

for f in sorted(Path(output_dir).glob('*.dcm'), key=lambda x: x.stat().st_size):
    size_mb = f.stat().st_size / (1024*1024)
    print(f'\nUploading {f.name} ({size_mb:.1f} MB)...')
    
    try:
        with open(f, 'rb') as fh:
            response = requests.post(
                f'{orthanc_url}/instances',
                data=fh.read(),
                headers={'Content-Type': 'application/dicom'},
                auth=auth,
                timeout=300
            )
        
        print(f'  Status: {response.status_code}')
        if response.status_code in [200, 201]:
            result = response.json()
            print(f'  Instance: {result.get("ID", "N/A")}')
            print(f'  Study: {result.get("ParentStudy", "N/A")}')
            print(f'  Series: {result.get("ParentSeries", "N/A")}')
        else:
            print(f'  Error: {response.text[:200]}')
    except Exception as e:
        print(f'  Exception: {e}')

print('\n=== Checking WSI Plugin ===')
# Get the study and check if WSI plugin recognizes it
try:
    studies = requests.get(f'{orthanc_url}/studies', auth=auth, timeout=10).json()
    if studies:
        study_id = studies[-1]  # Most recent
        study_info = requests.get(f'{orthanc_url}/studies/{study_id}', auth=auth, timeout=10).json()
        series_id = study_info['Series'][0]
        print(f'Series ID: {series_id}')
        
        wsi_response = requests.get(f'{orthanc_url}/wsi/pyramids/{series_id}', auth=auth, timeout=10)
        print(f'WSI Pyramid Status: {wsi_response.status_code}')
        if wsi_response.status_code == 200:
            print(f'WSI Info: {wsi_response.text[:500]}')
        else:
            print(f'WSI Error: {wsi_response.text[:200]}')
except Exception as e:
    print(f'Error checking WSI: {e}')


