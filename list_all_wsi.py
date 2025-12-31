#!/usr/bin/env python3
"""List all WSI series with working pyramids"""

import requests
import sys

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

print("Finding all WSI series with working pyramids...\n")

# Get all series
series_list = requests.get(f'{base_url}/series', auth=auth).json()

working_wsi = []

for series_id in series_list:
    series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
    modality = series_info.get('MainDicomTags', {}).get('Modality', '')
    
    if modality == 'SM':  # Slide Microscopy
        # Try to get pyramid info
        pyramid_response = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)
        
        if pyramid_response.status_code == 200:
            pyramid = pyramid_response.json()
            patient_name = series_info.get('MainDicomTags', {}).get('PatientName', 'Unknown')
            
            # Test if we can get a tile
            test_tile = requests.get(f'{base_url}/wsi/tiles/{series_id}/0/0/0', auth=auth)
            tile_ok = test_tile.status_code == 200 and len(test_tile.content) > 2200  # Not blank
            
            working_wsi.append({
                'series_id': series_id,
                'patient_name': patient_name,
                'size': f"{pyramid['TotalWidth']}x{pyramid['TotalHeight']}",
                'levels': len(pyramid['Resolutions']),
                'tiles_ok': tile_ok,
                'viewer_url': f"http://localhost:3000/?series={series_id}"
            })

print(f"Found {len(working_wsi)} WSI series:\n")

for wsi in working_wsi:
    status = "✓" if wsi['tiles_ok'] else "⚠"
    print(f"{status} {wsi['patient_name']}")
    print(f"   Series: {wsi['series_id']}")
    print(f"   Size: {wsi['size']}, Levels: {wsi['levels']}")
    print(f"   URL: {wsi['viewer_url']}")
    print()

# Find the best candidate (tiles working, multiple levels)
best = [w for w in working_wsi if w['tiles_ok'] and w['levels'] > 5]
if best:
    print(f"\nRecommended series to view:")
    print(f"  {best[0]['viewer_url']}")
