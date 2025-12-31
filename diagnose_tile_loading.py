#!/usr/bin/env python3
"""Diagnose tile loading issues - check all tiles systematically"""

import requests
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'
series_id = '315c8242-882c1e86-121fe508-4adc7e30-07a7d6c1'

print("Diagnosing tile loading for Leica image...\n")

# Get pyramid info
pyramid_response = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)
pyramid = pyramid_response.json()

# Focus on Level 0
level = 0
tiles_x = pyramid['TilesCount'][level][0]  # 61
tiles_y = pyramid['TilesCount'][level][1]  # 69

print(f"Level 0: {tiles_x}x{tiles_y} tiles (total: {tiles_x * tiles_y})\n")

# Test a grid of tiles to find patterns
print("Testing tile grid (. = ok, X = blank, E = error):\n")

# Map to track tile status
tile_status = {}
blank_tiles = []
error_tiles = []
slow_tiles = []

def check_tile(x, y):
    """Check a single tile and return its status"""
    start_time = time.time()
    tile_url = f"{base_url}/wsi/tiles/{series_id}/{level}/{x}/{y}"
    
    try:
        response = requests.get(tile_url, auth=auth, timeout=5)
        load_time = time.time() - start_time
        
        if response.status_code == 200:
            size = len(response.content)
            
            # Categorize based on size (blank tiles are typically < 4KB)
            if size < 4000:
                return 'blank', size, load_time
            else:
                return 'ok', size, load_time
        else:
            return 'error', 0, load_time
            
    except Exception as e:
        return 'timeout', 0, time.time() - start_time

# Test every Nth tile to get overview
sample_rate = 5  # Test every 5th tile
print(f"Sampling every {sample_rate}th tile...\n")

# Visual grid
for y in range(0, tiles_y, sample_rate):
    row = ""
    for x in range(0, tiles_x, sample_rate):
        status, size, load_time = check_tile(x, y)
        
        if status == 'ok':
            row += "."
            if load_time > 1.0:
                slow_tiles.append((x, y, load_time))
        elif status == 'blank':
            row += "X"
            blank_tiles.append((x, y))
        else:
            row += "E"
            error_tiles.append((x, y))
            
    print(row)

print(f"\n\nResults:")
print(f"  Blank tiles: {len(blank_tiles)}")
print(f"  Error tiles: {len(error_tiles)}")
print(f"  Slow tiles (>1s): {len(slow_tiles)}")

# Show specific problem areas
if blank_tiles:
    print(f"\nBlank tile locations (first 10):")
    for x, y in blank_tiles[:10]:
        print(f"  ({x},{y})")

if error_tiles:
    print(f"\nError tile locations:")
    for x, y in error_tiles[:10]:
        print(f"  ({x},{y})")

if slow_tiles:
    print(f"\nSlow tile locations:")
    for x, y, load_time in slow_tiles[:5]:
        print(f"  ({x},{y}) - {load_time:.1f}s")

# Test concurrent loading
print(f"\n\nTesting concurrent tile loading...")
successful_loads = 0
failed_loads = 0

with ThreadPoolExecutor(max_workers=10) as executor:
    # Submit 20 random tiles
    futures = []
    import random
    
    for _ in range(20):
        x = random.randint(10, tiles_x-10)  # Avoid edges
        y = random.randint(10, tiles_y-10)
        future = executor.submit(check_tile, x, y)
        futures.append((future, x, y))
    
    # Check results
    for future, x, y in futures:
        status, size, load_time = future.result()
        if status == 'ok':
            successful_loads += 1
        else:
            failed_loads += 1

print(f"  Successful: {successful_loads}/20")
print(f"  Failed: {failed_loads}/20")

# Check tile generation pattern
print(f"\n\nChecking tile patterns...")

# Check if there's a pattern to blank tiles (e.g., every other tile)
if blank_tiles:
    # Check for striping
    x_coords = [x for x, y in blank_tiles]
    y_coords = [y for x, y in blank_tiles]
    
    # Check if blank tiles follow a pattern
    x_pattern = all(x % 2 == 0 for x in x_coords) or all(x % 2 == 1 for x in x_coords)
    y_pattern = all(y % 2 == 0 for y in y_coords) or all(y % 2 == 1 for y in y_coords)
    
    if x_pattern or y_pattern:
        print("  ⚠ Blank tiles follow a regular pattern - possible systematic issue")
    else:
        print("  Blank tiles appear random - likely edge/background tiles")

# Check Orthanc load
print(f"\n\nChecking server status...")
stats_response = requests.get(f'{base_url}/statistics', auth=auth)
if stats_response.status_code == 200:
    stats = stats_response.json()
    print(f"  Total instances: {stats.get('CountInstances', 0)}")
    print(f"  Disk size: {stats.get('TotalDiskSizeMB', 0)} MB")

# Recommendations
print(f"\n\nRecommendations:")
if len(slow_tiles) > 5:
    print("  - Many tiles are slow to load. Consider:")
    print("    • Increasing Orthanc's thread count")
    print("    • Adding nginx caching for tiles")
    print("    • Checking server resources (CPU/memory)")

if len(blank_tiles) > tiles_x * tiles_y * 0.3:
    print("  - Many blank tiles detected. This could indicate:")
    print("    • Incomplete pyramid generation")
    print("    • Issues with the source DICOM files")
    print("    • Need to regenerate the pyramid")

if error_tiles:
    print("  - Some tiles are failing to load. Check:")
    print("    • Orthanc logs for errors")
    print("    • File system permissions")
    print("    • Available disk space")

print(f"\n\nTo fix patchy loading in the viewer:")
print("1. Clear browser cache completely")
print("2. Check browser console for 'net::ERR_INSUFFICIENT_RESOURCES' errors")
print("3. Try a different browser (Chrome handles many concurrent requests better)")
print("4. Reduce viewer tile prefetch if too aggressive")
print("5. Consider implementing tile request queuing in the viewer")
