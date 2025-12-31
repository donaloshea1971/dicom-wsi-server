#!/usr/bin/env python3
"""Test WSI tile access"""

import requests
import sys

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

# Test the 3DHISTECH-2 series
series_id = 'f746a6ec-50faf3bf-8c9a652f-cbb0490f-14eceea3'

print(f"Testing WSI tiles for series: {series_id}\n")

# Get pyramid info
pyramid_url = f'{base_url}/wsi/pyramids/{series_id}'
pyramid_response = requests.get(pyramid_url, auth=auth)

if pyramid_response.status_code == 200:
    pyramid = pyramid_response.json()
    print("Pyramid info:")
    print(f"  Total size: {pyramid['TotalWidth']}x{pyramid['TotalHeight']}")
    print(f"  Resolutions: {len(pyramid['Resolutions'])}")
    print(f"  Tile sizes: {pyramid['TilesSizes']}")
    print(f"  Tiles count per level: {pyramid['TilesCount']}")
    
    # Test tile access for first level
    print("\nTesting tile access...")
    
    # Try to get a tile from level 0
    tile_url = f"{base_url}/wsi/tiles/{series_id}/0/0/0"
    print(f"\nTesting tile URL: {tile_url}")
    tile_response = requests.get(tile_url, auth=auth)
    print(f"Tile response status: {tile_response.status_code}")
    
    if tile_response.status_code == 200:
        print(f"Tile size: {len(tile_response.content)} bytes")
        print(f"Content-Type: {tile_response.headers.get('Content-Type', 'Unknown')}")
    else:
        print(f"Error: {tile_response.text[:200]}")
    
    # Try the OpenSeadragon endpoint format
    osd_tile_url = f"{base_url}/wsi/tiles/{series_id}/0-0-0.jpg"
    print(f"\nTesting OSD format: {osd_tile_url}")
    osd_response = requests.get(osd_tile_url, auth=auth)
    print(f"OSD tile response: {osd_response.status_code}")
    
    # Check if this is a multi-file pyramid
    if pyramid.get('Type') == 'LeicaMultiFile' or pyramid.get('IsVirtualPyramid'):
        print("\nThis appears to be a multi-file pyramid (Leica format)")
        instance_ids = pyramid.get('InstanceIDs', [])
        print(f"Instance IDs: {instance_ids[:3]}... (total: {len(instance_ids)})")
else:
    print(f"Failed to get pyramid info: {pyramid_response.status_code}")
    print(pyramid_response.text[:500])

# Check the viewer URL
print(f"\n\nViewer URL: http://localhost:3000/?series={series_id}")
