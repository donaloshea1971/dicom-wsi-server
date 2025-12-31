#!/usr/bin/env python3
"""Verify high-resolution tiles are working"""

import requests
import sys
from PIL import Image
from io import BytesIO
import numpy as np

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

# Test the 3DHISTECH-1 series which should be working
series_id = 'fc2e90ad-4599bc0d-218785fd-114fa180-9a6228bf'

print("Verifying high-resolution tiles for 3DHISTECH-1...\n")

# Get pyramid info
pyramid_response = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)

if pyramid_response.status_code == 200:
    pyramid = pyramid_response.json()
    print(f"Pyramid info:")
    print(f"  Total size: {pyramid['TotalWidth']}x{pyramid['TotalHeight']}")
    print(f"  Pyramid levels: {len(pyramid['Resolutions'])}")
    
    # Show all levels
    print(f"\nPyramid structure:")
    for i, (res, size, tiles) in enumerate(zip(pyramid['Resolutions'], pyramid['Sizes'], pyramid['TilesCount'])):
        print(f"  Level {i}: {size[0]}x{size[1]} pixels, {tiles[0]}x{tiles[1]} tiles (1:{res} scale)")
    
    # Test high-resolution tiles (Level 0)
    print(f"\n\nTesting Level 0 (highest resolution) tiles:")
    level = 0
    tiles_x = pyramid['TilesCount'][level][0]
    tiles_y = pyramid['TilesCount'][level][1]
    
    # Test multiple tiles across the image
    test_positions = [
        (0, 0, "Top-left corner"),
        (tiles_x//4, tiles_y//4, "Quarter position"),
        (tiles_x//2, tiles_y//2, "Center"),
        (3*tiles_x//4, 3*tiles_y//4, "Three-quarter position"),
        (min(tiles_x-1, 111), min(tiles_y-1, 117), "Bottom-right area")
    ]
    
    blank_count = 0
    valid_count = 0
    
    for x, y, desc in test_positions:
        if x < tiles_x and y < tiles_y:
            tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{x}/{y}"
            response = requests.get(tile_url, auth=auth)
            
            print(f"\n  Tile ({x},{y}) - {desc}:")
            print(f"    URL: /wsi/tiles/{series_id}/{level}/{x}/{y}")
            print(f"    Status: {response.status_code}")
            
            if response.status_code == 200:
                size = len(response.content)
                print(f"    Size: {size} bytes")
                
                # Analyze tile content
                try:
                    img = Image.open(BytesIO(response.content))
                    img_array = np.array(img)
                    
                    # Calculate statistics
                    if len(img_array.shape) == 3:  # RGB/RGBA
                        std_dev = np.std(img_array[:,:,:3])  # Ignore alpha if present
                        mean_val = np.mean(img_array[:,:,:3])
                    else:  # Grayscale
                        std_dev = np.std(img_array)
                        mean_val = np.mean(img_array)
                    
                    print(f"    Image: {img.size[0]}x{img.size[1]} {img.mode}")
                    print(f"    Mean pixel value: {mean_val:.1f}")
                    print(f"    Std deviation: {std_dev:.1f}")
                    
                    # Check if blank (low standard deviation)
                    if std_dev < 1.0:
                        print(f"    ⚠ WARNING: Tile appears to be blank/uniform")
                        blank_count += 1
                    else:
                        print(f"    ✓ Tile contains varied image data")
                        valid_count += 1
                        
                except Exception as e:
                    print(f"    Error analyzing: {e}")
    
    print(f"\n\nSummary:")
    print(f"  Valid tiles with content: {valid_count}")
    print(f"  Blank/uniform tiles: {blank_count}")
    
    if valid_count > 0:
        print(f"\n✓ High-resolution tiles ARE working for this dataset")
    else:
        print(f"\n✗ High-resolution tiles are NOT working properly")
    
    # Test a few more random positions
    print(f"\n\nTesting additional random positions at Level 0:")
    import random
    for i in range(5):
        x = random.randint(0, min(tiles_x-1, 200))
        y = random.randint(0, min(tiles_y-1, 200))
        
        tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{x}/{y}"
        response = requests.get(tile_url, auth=auth)
        
        if response.status_code == 200:
            size = len(response.content)
            status = "✓ Has content" if size > 3000 else "⚠ Possibly blank"
            print(f"  Tile ({x},{y}): {size} bytes - {status}")
    
    print(f"\n\nViewer URL: http://localhost:3000/?series={series_id}")
    print("Open this URL and zoom in to verify you can see high-resolution details.")
    
else:
    print(f"Failed to get pyramid info: {pyramid_response.status_code}")
