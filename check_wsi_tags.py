#!/usr/bin/env python3
"""Check WSI DICOM tags"""

import requests
import sys

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

# Get the series for patient 20240917094737
series_id = 'f746a6ec-50faf3bf-8c9a652f-cbb0490f-14eceea3'

print(f"Checking WSI tags for series: {series_id}\n")

# Get series info
series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
instances = series_info.get('Instances', [])

print(f"Total instances in series: {len(instances)}")

# Check first few instances for WSI-specific tags
for i, instance_id in enumerate(instances[:3]):
    print(f"\n--- Instance {i+1} ({instance_id}) ---")
    
    tags = requests.get(f'{base_url}/instances/{instance_id}/tags', auth=auth).json()
    
    # Key WSI tags
    wsi_tags = {
        '0048,0001': 'Imaged Volume Width',
        '0048,0002': 'Imaged Volume Height',
        '0048,0003': 'Imaged Volume Depth',
        '0048,0006': 'Total Pixel Matrix Columns',
        '0048,0007': 'Total Pixel Matrix Rows',
        '0048,0008': 'Total Pixel Matrix Origin Sequence',
        '0048,0010': 'Specimen Label in Image',
        '0048,0011': 'Focus Method',
        '0048,0012': 'Extended Depth of Field',
        '0048,0013': 'Number of Focal Planes',
        '0048,0014': 'Distance Between Focal Planes',
        '0048,0102': 'Image Orientation (Slide)',
        '0048,0105': 'Optical Path Sequence',
        '0048,0106': 'Optical Path Identifier',
        '0048,0200': 'Referenced Image Navigation Sequence',
        '0048,0201': 'Top Left Hand Corner of Localizer Area',
        '0048,0202': 'Bottom Right Hand Corner of Localizer Area',
        '0008,0008': 'Image Type',
        '0028,0010': 'Rows',
        '0028,0011': 'Columns',
        '0020,0013': 'Instance Number',
        '0008,0060': 'Modality',
        '0008,0016': 'SOP Class UID',
    }
    
    for tag, name in wsi_tags.items():
        if tag in tags:
            value = tags[tag].get('Value', ['N/A'])
            if isinstance(value, list) and len(value) > 0:
                value = value[0]
            print(f"  {name} ({tag}): {value}")
    
    # Check if it has the Dimension Organization Sequence (important for WSI)
    if '0020,9221' in tags:
        print("  Has Dimension Organization Sequence")
    
    # Check if it has Per-Frame Functional Groups Sequence
    if '5200,9230' in tags:
        print("  Has Per-Frame Functional Groups Sequence")

# Check if we can access the WSI viewer for this series
print(f"\n\nChecking WSI viewer access...")
wsi_url = f"{base_url}/wsi/series/{series_id}"
response = requests.get(wsi_url, auth=auth)
print(f"WSI series endpoint ({wsi_url}): {response.status_code}")

if response.status_code == 200:
    wsi_data = response.json()
    print(f"WSI data: {wsi_data}")

# Try the tiles endpoint
tiles_url = f"{base_url}/wsi/tiles/{series_id}"
response = requests.get(tiles_url, auth=auth)
print(f"\nWSI tiles endpoint ({tiles_url}): {response.status_code}")

# Check viewer URL
viewer_url = f"http://localhost:8080/?series={series_id}"
print(f"\nViewer URL: {viewer_url}")
