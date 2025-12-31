#!/usr/bin/env python3
"""Check specific image by SOP Instance UID"""

import requests
import sys
from PIL import Image
from io import BytesIO

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'
sop_instance_uid = '1.3.6.1.4.1.5962.99.1.3073532328.211211830.1686700745128.5.0'

print(f"Searching for SOP Instance UID: {sop_instance_uid}\n")

# Search for this instance
search_data = {
    "Level": "Instance",
    "Query": {
        "SOPInstanceUID": sop_instance_uid
    }
}

response = requests.post(f'{base_url}/tools/find', auth=auth, json=search_data)
if response.status_code == 200:
    instances = response.json()
    if instances:
        instance_id = instances[0]
        print(f"Found instance: {instance_id}")
        
        # Get instance details
        instance_info = requests.get(f'{base_url}/instances/{instance_id}', auth=auth).json()
        series_id = instance_info['ParentSeries']
        
        # Get series info
        series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
        print(f"Series ID: {series_id}")
        print(f"Patient: {series_info.get('MainDicomTags', {}).get('PatientName', 'Unknown')}")
        print(f"Modality: {series_info.get('MainDicomTags', {}).get('Modality', 'Unknown')}")
        
        # Get instance tags
        tags = requests.get(f'{base_url}/instances/{instance_id}/tags', auth=auth).json()
        
        print(f"\nImage details:")
        print(f"  Rows: {tags.get('0028,0010', {}).get('Value', ['?'])[0]}")
        print(f"  Columns: {tags.get('0028,0011', {}).get('Value', ['?'])[0]}")
        print(f"  Image Type: {tags.get('0008,0008', {}).get('Value', ['?'])}")
        
        if '0048,0006' in tags:
            print(f"  Total Matrix Columns: {tags['0048,0006']['Value'][0]}")
            print(f"  Total Matrix Rows: {tags['0048,0007']['Value'][0]}")
        
        # Check pyramid info
        print(f"\nChecking WSI pyramid...")
        pyramid_response = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)
        
        if pyramid_response.status_code == 200:
            pyramid = pyramid_response.json()
            print(f"✓ Pyramid found:")
            print(f"  Total size: {pyramid['TotalWidth']}x{pyramid['TotalHeight']}")
            print(f"  Levels: {len(pyramid['Resolutions'])}")
            print(f"  Resolutions: {pyramid['Resolutions']}")
            
            # Test tiles at different levels
            print(f"\nTesting tile quality at different pyramid levels:")
            
            # Test center tiles at different levels
            test_levels = [0, len(pyramid['Resolutions'])//2, len(pyramid['Resolutions'])-1]
            
            for level in test_levels:
                if level < len(pyramid['TilesCount']):
                    tiles_x = pyramid['TilesCount'][level][0]
                    tiles_y = pyramid['TilesCount'][level][1]
                    
                    # Get center tile
                    center_x = tiles_x // 2
                    center_y = tiles_y // 2
                    
                    tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{center_x}/{center_y}"
                    tile_response = requests.get(tile_url, auth=auth)
                    
                    print(f"\n  Level {level} (Resolution 1:{pyramid['Resolutions'][level]}):")
                    print(f"    Tile grid: {tiles_x}x{tiles_y}")
                    print(f"    Testing center tile ({center_x},{center_y})")
                    print(f"    Status: {tile_response.status_code}")
                    
                    if tile_response.status_code == 200:
                        print(f"    Size: {len(tile_response.content)} bytes")
                        
                        # Check if it's a blank tile
                        try:
                            img = Image.open(BytesIO(tile_response.content))
                            extrema = img.getextrema()
                            
                            if img.mode == 'RGB':
                                if all(e[0] == e[1] for e in extrema):
                                    print(f"    ⚠ WARNING: Tile appears to be blank/uniform")
                                else:
                                    print(f"    ✓ Tile contains image data")
                                    # Check pixel variance
                                    pixels = list(img.getdata())
                                    unique_pixels = len(set(pixels))
                                    print(f"    Unique pixels: {unique_pixels}")
                            elif img.mode == 'RGBA':
                                if all(e[0] == e[1] for e in extrema):
                                    print(f"    ⚠ WARNING: Tile appears to be blank/uniform")
                                else:
                                    print(f"    ✓ Tile contains image data")
                        except Exception as e:
                            print(f"    Error analyzing tile: {e}")
            
            # Check specific high-res tiles
            print(f"\n\nChecking specific high-resolution tiles (Level 0):")
            # Test several tiles from level 0
            test_tiles = [(0, 0), (10, 10), (50, 50), (100, 100), (200, 200)]
            
            for x, y in test_tiles:
                if x < pyramid['TilesCount'][0][0] and y < pyramid['TilesCount'][0][1]:
                    tile_url = f"{base_url}/wsi/tiles/{series_id}/0/{x}/{y}"
                    tile_response = requests.get(tile_url, auth=auth)
                    
                    if tile_response.status_code == 200:
                        size = len(tile_response.content)
                        status = "✓ OK" if size > 3000 else "⚠ Possibly blank"
                        print(f"  Tile (0,{x},{y}): {size} bytes - {status}")
            
            print(f"\n\nViewer URL: http://localhost:3000/?series={series_id}")
            
        else:
            print(f"✗ No pyramid found for this series")
            
    else:
        print("Instance not found in Orthanc")
else:
    print(f"Search failed: {response.status_code}")
