#!/usr/bin/env python3
"""Debug 3DHISTECH images"""

import requests
import sys
from PIL import Image
from io import BytesIO

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

# Compare working vs broken images
images = [
    ('Leica (WORKING)', '315c8242-882c1e86-121fe508-4adc7e30-07a7d6c1'),
    ('3DHISTECH-1 (BROKEN)', 'fc2e90ad-4599bc0d-218785fd-114fa180-9a6228bf'),
]

for name, series_id in images:
    print(f'\n{"="*60}')
    print(f'{name}')
    print(f'{"="*60}')
    
    r = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)
    p = r.json()
    
    print(f'Total size: {p["TotalWidth"]}x{p["TotalHeight"]}')
    print(f'Levels: {len(p["Resolutions"])}')
    
    print(f'\nPyramid structure:')
    for i in range(min(4, len(p['Resolutions']))):
        size = f'{p["Sizes"][i][0]}x{p["Sizes"][i][1]}'
        tiles = f'{p["TilesCount"][i][0]}x{p["TilesCount"][i][1]}'
        tile_size = f'{p["TilesSizes"][i][0]}x{p["TilesSizes"][i][1]}'
        print(f'  Level {i}: size={size}, tiles={tiles}, tileSize={tile_size}')
    
    # Test tile retrieval
    print(f'\nTesting tiles:')
    
    # Get center tile at level 0
    tiles_x = p['TilesCount'][0][0]
    tiles_y = p['TilesCount'][0][1]
    center_x = tiles_x // 2
    center_y = tiles_y // 2
    
    tile_url = f'{base_url}/wsi/tiles/{series_id}/0/{center_x}/{center_y}'
    tile_r = requests.get(tile_url, auth=auth)
    
    print(f'  URL: /wsi/tiles/{series_id}/0/{center_x}/{center_y}')
    print(f'  Status: {tile_r.status_code}')
    print(f'  Size: {len(tile_r.content)} bytes')
    print(f'  Content-Type: {tile_r.headers.get("Content-Type", "Unknown")}')
    
    # Analyze tile content
    if tile_r.status_code == 200 and len(tile_r.content) > 100:
        try:
            img = Image.open(BytesIO(tile_r.content))
            print(f'  Image: {img.size[0]}x{img.size[1]} {img.mode}')
            
            # Check pixel values
            pixels = list(img.getdata())
            if img.mode == 'RGB':
                avg_r = sum(p[0] for p in pixels) / len(pixels)
                avg_g = sum(p[1] for p in pixels) / len(pixels)
                avg_b = sum(p[2] for p in pixels) / len(pixels)
                print(f'  Avg RGB: ({avg_r:.0f}, {avg_g:.0f}, {avg_b:.0f})')
                
                # Check for all white (255,255,255) or all black (0,0,0)
                if avg_r > 250 and avg_g > 250 and avg_b > 250:
                    print(f'  ⚠ WARNING: Tile appears to be WHITE')
                elif avg_r < 5 and avg_g < 5 and avg_b < 5:
                    print(f'  ⚠ WARNING: Tile appears to be BLACK')
                else:
                    print(f'  ✓ Tile has varied content')
            elif img.mode == 'RGBA':
                avg_r = sum(p[0] for p in pixels) / len(pixels)
                avg_g = sum(p[1] for p in pixels) / len(pixels)
                avg_b = sum(p[2] for p in pixels) / len(pixels)
                avg_a = sum(p[3] for p in pixels) / len(pixels)
                print(f'  Avg RGBA: ({avg_r:.0f}, {avg_g:.0f}, {avg_b:.0f}, {avg_a:.0f})')
                
                if avg_a < 5:
                    print(f'  ⚠ WARNING: Tile is TRANSPARENT')
                elif avg_r > 250 and avg_g > 250 and avg_b > 250:
                    print(f'  ⚠ WARNING: Tile appears to be WHITE')
                elif avg_r < 5 and avg_g < 5 and avg_b < 5:
                    print(f'  ⚠ WARNING: Tile appears to be BLACK')
                else:
                    print(f'  ✓ Tile has varied content')
                    
        except Exception as e:
            print(f'  Error analyzing: {e}')
    
    # Save a test tile for visual inspection
    if tile_r.status_code == 200:
        filename = f'test_tile_{name.split()[0].lower()}.png'
        with open(filename, 'wb') as f:
            f.write(tile_r.content)
        print(f'  Saved to: {filename}')
