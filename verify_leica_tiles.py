#!/usr/bin/env python3
"""Verify high-resolution tiles for the Leica image"""

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

# Based on the dimensions 15374×17497, this is series 315c8242
series_id = '315c8242-882c1e86-121fe508-4adc7e30-07a7d6c1'

print("Verifying high-resolution tiles for Leica Aperio image...\n")

# Get pyramid info
pyramid_response = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)

if pyramid_response.status_code == 200:
    pyramid = pyramid_response.json()
    print(f"Image info:")
    print(f"  Total size: {pyramid['TotalWidth']}x{pyramid['TotalHeight']} pixels")
    print(f"  Pyramid levels: {len(pyramid['Resolutions'])}")
    print(f"  Background color: {pyramid.get('BackgroundColor', 'N/A')}")
    
    # Verify this matches the metadata
    if pyramid['TotalWidth'] == 15374 and pyramid['TotalHeight'] == 17497:
        print("  ✓ This is the correct Leica Aperio image")
    
    # Show pyramid structure
    print(f"\nPyramid structure:")
    for i, (res, size, tiles, tile_size) in enumerate(zip(
        pyramid['Resolutions'], 
        pyramid['Sizes'], 
        pyramid['TilesCount'],
        pyramid['TilesSizes']
    )):
        print(f"  Level {i}: {size[0]}x{size[1]} pixels, "
              f"{tiles[0]}x{tiles[1]} tiles of {tile_size[0]}x{tile_size[1]} "
              f"(scale 1:{res})")
    
    # Test high-resolution tiles at Level 0
    print(f"\n\nTesting Level 0 (highest resolution) tiles:")
    level = 0
    tiles_x = pyramid['TilesCount'][level][0]
    tiles_y = pyramid['TilesCount'][level][1]
    tile_width = pyramid['TilesSizes'][level][0]
    tile_height = pyramid['TilesSizes'][level][1]
    
    print(f"Level 0 has {tiles_x}x{tiles_y} tiles of {tile_width}x{tile_height} pixels each")
    
    # Test tiles across the image
    test_positions = [
        (0, 0, "Top-left corner"),
        (tiles_x//4, tiles_y//4, "Quarter position"),
        (tiles_x//2, tiles_y//2, "Center"),
        (3*tiles_x//4, 3*tiles_y//4, "Three-quarter position"),
        (tiles_x-1, tiles_y-1, "Bottom-right corner")
    ]
    
    blank_count = 0
    valid_count = 0
    failed_count = 0
    
    for x, y, desc in test_positions:
        if x < tiles_x and y < tiles_y:
            tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{x}/{y}"
            response = requests.get(tile_url, auth=auth)
            
            print(f"\n  Tile ({x},{y}) - {desc}:")
            print(f"    Status: {response.status_code}")
            
            if response.status_code == 200:
                size = len(response.content)
                print(f"    Size: {size:,} bytes")
                
                # Analyze tile content
                try:
                    img = Image.open(BytesIO(response.content))
                    img_array = np.array(img)
                    
                    # Calculate statistics
                    if len(img_array.shape) == 3:  # RGB/RGBA
                        std_dev = np.std(img_array[:,:,:3])
                        mean_val = np.mean(img_array[:,:,:3])
                        unique_colors = len(np.unique(img_array.reshape(-1, img_array.shape[-1]), axis=0))
                    else:  # Grayscale
                        std_dev = np.std(img_array)
                        mean_val = np.mean(img_array)
                        unique_colors = len(np.unique(img_array))
                    
                    print(f"    Image: {img.size[0]}x{img.size[1]} {img.mode}")
                    print(f"    Mean pixel value: {mean_val:.1f}")
                    print(f"    Std deviation: {std_dev:.1f}")
                    print(f"    Unique colors: {unique_colors}")
                    
                    # Check if blank
                    if std_dev < 1.0 or unique_colors < 10:
                        print(f"    ⚠ WARNING: Tile appears to be blank/uniform")
                        blank_count += 1
                    else:
                        print(f"    ✓ Tile contains varied image data")
                        valid_count += 1
                        
                except Exception as e:
                    print(f"    Error analyzing: {e}")
                    failed_count += 1
            else:
                print(f"    ✗ Failed to retrieve tile")
                failed_count += 1
    
    # Test specific tiles in the middle of the image
    print(f"\n\nTesting additional center tiles:")
    center_x = tiles_x // 2
    center_y = tiles_y // 2
    
    for dx in [-2, -1, 0, 1, 2]:
        x = center_x + dx
        y = center_y
        
        if 0 <= x < tiles_x:
            tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{x}/{y}"
            response = requests.get(tile_url, auth=auth)
            
            if response.status_code == 200:
                size = len(response.content)
                status = "✓ Has content" if size > 1000 else "⚠ Possibly blank"
                print(f"  Tile ({x},{y}): {size:,} bytes - {status}")
    
    print(f"\n\nSummary:")
    print(f"  Valid tiles with content: {valid_count}")
    print(f"  Blank/uniform tiles: {blank_count}")
    print(f"  Failed to load: {failed_count}")
    
    if valid_count > 0:
        print(f"\n✓ High-resolution tiles ARE being served")
        if blank_count > 0:
            print(f"  Note: Some tiles are blank, which is normal for image borders")
    else:
        print(f"\n✗ High-resolution tiles are NOT working properly")
    
    print(f"\n\nDiagnostics:")
    print(f"  Expected tile size: {tile_width}x{tile_height}")
    print(f"  Pyramid type: {pyramid.get('Type', 'Standard')}")
    
    # Check if this is a virtual pyramid
    if pyramid.get('IsVirtualPyramid'):
        print(f"  ⚠ This is a virtual pyramid - tiles may be generated on demand")
    
    print(f"\n\nViewer URL: http://localhost:3000/?series={series_id}")
    print("If high-res tiles aren't showing in the viewer:")
    print("  1. Try a hard refresh (Ctrl+Shift+R)")
    print("  2. Check browser console for errors")
    print("  3. Ensure you're zooming in sufficiently (use mouse wheel or zoom controls)")
    
else:
    print(f"Failed to get pyramid info: {pyramid_response.status_code}")
    print(pyramid_response.text)
