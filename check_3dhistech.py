#!/usr/bin/env python3
"""Check 3DHISTECH images status"""

import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

series_ids = [
    ('3DHISTECH-1', 'fc2e90ad-4599bc0d-218785fd-114fa180-9a6228bf'),
    ('3DHISTECH-2', 'f746a6ec-50faf3bf-8c9a652f-cbb0490f-14eceea3'),
]

for name, series_id in series_ids:
    print(f'\n{name} ({series_id}):')
    
    # Check if series exists
    series_r = requests.get(f'{base_url}/series/{series_id}', auth=auth)
    if series_r.status_code != 200:
        print(f'  ✗ Series not found!')
        continue
    
    series_info = series_r.json()
    instances = series_info.get('Instances', [])
    print(f'  Instances: {len(instances)}')
    
    # Check pyramid
    r = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)
    print(f'  Pyramid status: {r.status_code}')
    
    if r.status_code == 200:
        pyramid = r.json()
        print(f'  Size: {pyramid["TotalWidth"]}x{pyramid["TotalHeight"]}')
        print(f'  Levels: {len(pyramid["Resolutions"])}')
        print(f'  Tile sizes: {pyramid["TilesSizes"][0]}')
        
        # Test multiple tiles
        tiles_x = pyramid['TilesCount'][0][0]
        tiles_y = pyramid['TilesCount'][0][1]
        
        print(f'  Testing tiles at level 0 ({tiles_x}x{tiles_y} grid):')
        
        test_positions = [(0, 0), (5, 5), (tiles_x//2, tiles_y//2)]
        for x, y in test_positions:
            if x < tiles_x and y < tiles_y:
                tile_r = requests.get(f'{base_url}/wsi/tiles/{series_id}/0/{x}/{y}', auth=auth)
                size = len(tile_r.content)
                status = "✓" if size > 3000 else "⚠ blank"
                print(f'    Tile ({x},{y}): {tile_r.status_code}, {size} bytes {status}')
    else:
        print(f'  Error: {r.text[:200]}')
