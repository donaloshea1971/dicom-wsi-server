#!/usr/bin/env python3
"""Test different tile levels to verify they contain actual image data"""

import requests
import sys
from PIL import Image
from io import BytesIO

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'
series_id = 'f746a6ec-50faf3bf-8c9a652f-cbb0490f-14eceea3'

print("Testing tile quality at different pyramid levels...\n")

# Test tiles from different levels
test_cases = [
    (0, 0, 0, "Level 0 - Highest resolution"),
    (0, 100, 100, "Level 0 - Middle area"),
    (3, 10, 10, "Level 3 - Medium resolution"), 
    (6, 2, 2, "Level 6 - Low resolution"),
    (9, 0, 0, "Level 9 - Lowest resolution")
]

for level, x, y, desc in test_cases:
    tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{x}/{y}"
    print(f"\n{desc}:")
    print(f"  URL: /wsi/tiles/{series_id}/{level}/{x}/{y}")
    
    response = requests.get(tile_url, auth=auth)
    
    if response.status_code == 200:
        print(f"  Status: {response.status_code} OK")
        print(f"  Size: {len(response.content)} bytes")
        print(f"  Content-Type: {response.headers.get('Content-Type', 'Unknown')}")
        
        # Try to open as image to check if it's valid
        try:
            img = Image.open(BytesIO(response.content))
            print(f"  Image: {img.size[0]}x{img.size[1]} {img.mode}")
            
            # Check if image is not blank
            extrema = img.getextrema()
            if img.mode == 'RGB':
                # Check if all channels have the same min/max (likely blank)
                if all(e[0] == e[1] for e in extrema):
                    print("  WARNING: Image appears to be blank (uniform color)")
                else:
                    print("  ✓ Image contains varied content")
            else:
                if extrema[0] == extrema[1]:
                    print("  WARNING: Image appears to be blank")
                else:
                    print("  ✓ Image contains content")
                    
        except Exception as e:
            print(f"  Error loading image: {e}")
    else:
        print(f"  Status: {response.status_code} - {response.text[:100]}")

# Test if tiles are actually different at different zoom levels
print("\n\nComparing tile content between levels...")
tile1_url = f"{base_url}/wsi/tiles/{series_id}/0/50/50"
tile2_url = f"{base_url}/wsi/tiles/{series_id}/3/6/6"  # Roughly same area at lower res

r1 = requests.get(tile1_url, auth=auth)
r2 = requests.get(tile2_url, auth=auth)

if r1.status_code == 200 and r2.status_code == 200:
    print(f"Level 0 tile size: {len(r1.content)} bytes")
    print(f"Level 3 tile size: {len(r2.content)} bytes")
    
    if r1.content == r2.content:
        print("WARNING: Tiles from different levels have identical content!")
    else:
        print("✓ Tiles from different levels have different content")

# Check viewer proxy
print("\n\nTesting through viewer proxy...")
proxy_tile_url = f"http://localhost:3000/wsi/tiles/{series_id}/0/0/0"
try:
    proxy_response = requests.get(proxy_tile_url)
    print(f"Proxy tile status: {proxy_response.status_code}")
    if proxy_response.status_code == 200:
        print(f"Proxy tile size: {len(proxy_response.content)} bytes")
except Exception as e:
    print(f"Proxy error: {e}")
